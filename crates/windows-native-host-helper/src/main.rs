use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};

const PROTOCOL_VERSION: u8 = 1;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const HELPER_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema_version: u8,
    request_id: String,
    command: Command,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Command {
    Health,
    ReleaseInfo,
}

#[derive(Debug, Serialize)]
struct Response {
    schema_version: u8,
    request_id: String,
    ok: bool,
    result: ResultBody,
    can_execute: bool,
    can_authenticate: bool,
    can_manage_components: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum ResultBody {
    Health {
        status: &'static str,
    },
    ReleaseInfo {
        helper_id: &'static str,
        helper_version: &'static str,
        target: &'static str,
        signing_status: &'static str,
    },
    Error {
        code: &'static str,
    },
}

fn read_frame(input: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut size = [0_u8; 4];
    match input.read_exact(&mut size) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_le_bytes(size) as usize;
    if length == 0 || length > MAX_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame length rejected",
        ));
    }
    let mut payload = vec![0_u8; length];
    input.read_exact(&mut payload)?;
    Ok(Some(payload))
}

fn write_frame(output: &mut impl Write, response: &Response) -> io::Result<()> {
    let payload = serde_json::to_vec(response)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "response serialization failed"))?;
    if payload.len() > MAX_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "response length rejected",
        ));
    }
    output.write_all(&(payload.len() as u32).to_le_bytes())?;
    output.write_all(&payload)?;
    output.flush()
}

fn safe_request_id(value: &str) -> Option<&str> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return None;
    }
    Some(value)
}

fn handle_payload(payload: &[u8]) -> Response {
    let request = serde_json::from_slice::<Request>(payload);
    match request {
        Ok(request) if request.schema_version == PROTOCOL_VERSION => {
            match safe_request_id(&request.request_id) {
                Some(request_id) => match request.command {
                    Command::Health => Response {
                        schema_version: PROTOCOL_VERSION,
                        request_id: request_id.to_owned(),
                        ok: true,
                        result: ResultBody::Health { status: "ready" },
                        can_execute: false,
                        can_authenticate: false,
                        can_manage_components: false,
                    },
                    Command::ReleaseInfo => Response {
                        schema_version: PROTOCOL_VERSION,
                        request_id: request_id.to_owned(),
                        ok: true,
                        result: ResultBody::ReleaseInfo {
                            helper_id: "awo-native-host-helper",
                            helper_version: HELPER_VERSION,
                            target: "x86_64-pc-windows-msvc",
                            signing_status: "unsigned-candidate",
                        },
                        can_execute: false,
                        can_authenticate: false,
                        can_manage_components: false,
                    },
                },
                None => error_response("invalid-request-id"),
            }
        }
        Ok(_) => error_response("schema-version-rejected"),
        Err(_) => error_response("request-rejected"),
    }
}

fn main() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    while let Some(payload) = read_frame(&mut input)? {
        write_frame(&mut output, &handle_payload(&payload))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_info_is_fixed_read_only_candidate_metadata() {
        let response = handle_payload(
            br#"{"schema_version":1,"request_id":"probe-1","command":"release-info"}"#,
        );
        assert!(response.ok);
        assert_eq!(response.request_id, "probe-1");
        assert!(
            !response.can_execute && !response.can_authenticate && !response.can_manage_components
        );
        match response.result {
            ResultBody::ReleaseInfo {
                target,
                signing_status,
                ..
            } => {
                assert_eq!(target, "x86_64-pc-windows-msvc");
                assert_eq!(signing_status, "unsigned-candidate");
            }
            _ => panic!("release-info must not return a capability payload"),
        }
    }

    #[test]
    fn unknown_fields_and_non_allowlisted_commands_are_rejected() {
        let unknown_field = handle_payload(
            br#"{"schema_version":1,"request_id":"probe-2","command":"health","path":"forbidden"}"#,
        );
        assert!(!unknown_field.ok);
        let unknown_command =
            handle_payload(br#"{"schema_version":1,"request_id":"probe-3","command":"shell"}"#);
        assert!(!unknown_command.ok);
        assert!(!unknown_field.can_execute && !unknown_command.can_execute);
    }
}

fn error_response(code: &'static str) -> Response {
    Response {
        schema_version: PROTOCOL_VERSION,
        request_id: "rejected".to_owned(),
        ok: false,
        result: ResultBody::Error { code },
        can_execute: false,
        can_authenticate: false,
        can_manage_components: false,
    }
}

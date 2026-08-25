const MAX_EXTERNAL_URL_CHARS: usize = 2_048;

fn validated_external_url(value: &str) -> Result<&str, &'static str> {
    let url = value.trim();
    if url.is_empty()
        || url.len() > MAX_EXTERNAL_URL_CHARS
        || (!url.starts_with("https://") && !url.starts_with("http://"))
        || url.chars().any(char::is_control)
    {
        return Err("external-url-invalid");
    }
    Ok(url)
}

/// Opens an explicitly clicked public HTTP(S) source in the operating system browser.
/// This is intentionally not a general shell command and never accepts file, custom, or private schemes.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), &'static str> {
    let url = validated_external_url(&url)?;
    #[cfg(mobile)]
    {
        // Android/iOS opener delegates only an explicitly validated HTTP(S) link to the
        // system default browser. It is not a shell bridge and never receives file paths.
        return tauri_plugin_opener::open_url(url, None::<&str>)
            .map_err(|_| "external-url-open-failed");
    }
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("rundll32.exe");
        command.args(["url.dll,FileProtocolHandler", url]);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(all(not(mobile), not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url);
        command
    };
    command.spawn().map_err(|_| "external-url-open-failed")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validated_external_url;

    #[test]
    fn only_accepts_public_http_and_https_urls() {
        assert_eq!(
            validated_external_url("https://example.com/page").unwrap(),
            "https://example.com/page"
        );
        assert!(validated_external_url("file:///C:/secret.txt").is_err());
        assert!(validated_external_url("javascript:alert(1)").is_err());
        assert!(validated_external_url("https://example.com/\nnext").is_err());
    }
}

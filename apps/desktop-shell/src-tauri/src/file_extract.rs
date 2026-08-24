use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::io::{Cursor, Read};
use zip::ZipArchive;

const MAX_FILE_BYTES: usize = 10 * 1024 * 1024;
const MAX_OUTPUT_CHARS: usize = 1_000_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractFileContentRequest {
    pub name: String,
    pub base64_data: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractFileContentResponse {
    pub content: String,
    pub format: String,
}

fn extension(name: &str) -> String {
    name.rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}
fn trim_output(value: String) -> String {
    value.chars().take(MAX_OUTPUT_CHARS).collect::<String>()
}
fn strip_xml(value: &str) -> String {
    let mut output = String::new();
    let mut tag = false;
    for character in value.chars() {
        match character {
            '<' => {
                tag = true;
                output.push(' ');
            }
            '>' => tag = false,
            _ if !tag => output.push(character),
            _ => {}
        }
    }
    output.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn read_zip_text(bytes: &[u8], include: impl Fn(&str) -> bool) -> Result<String, &'static str> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|_| "file-archive-invalid")?;
    let mut output = String::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| "file-archive-invalid")?;
        let name = entry.name().to_owned();
        if !include(&name) || entry.size() > 2 * 1024 * 1024 {
            continue;
        }
        let mut text = String::new();
        entry
            .read_to_string(&mut text)
            .map_err(|_| "file-archive-read-failed")?;
        output.push_str(&format!("\n\n===== {} =====\n{}", name, strip_xml(&text)));
        if output.chars().count() >= MAX_OUTPUT_CHARS {
            break;
        }
    }
    (!output.trim().is_empty())
        .then_some(trim_output(output))
        .ok_or("file-readable-content-missing")
}
fn archive_listing(bytes: &[u8]) -> Result<String, &'static str> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|_| "file-archive-invalid")?;
    let mut output = String::from("压缩包包含以下文件：\n");
    for index in 0..archive.len().min(200) {
        let entry = archive
            .by_index(index)
            .map_err(|_| "file-archive-invalid")?;
        output.push_str(&format!("- {} ({} bytes)\n", entry.name(), entry.size()));
    }
    Ok(output)
}

#[tauri::command]
pub fn extract_file_content(
    request: ExtractFileContentRequest,
) -> Result<ExtractFileContentResponse, &'static str> {
    if request.name.trim().is_empty()
        || request.name.len() > 512
        || request.base64_data.len() > 15_000_000
    {
        return Err("file-extract-request-invalid");
    }
    let bytes = STANDARD
        .decode(request.base64_data)
        .map_err(|_| "file-base64-invalid")?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err("file-too-large");
    }
    let ext = extension(&request.name);
    let content = match ext.as_str() {
        "pdf" => pdf_extract::extract_text_from_mem(&bytes)
            .map_err(|_| "file-pdf-extract-failed")
            .map(trim_output)?,
        "docx" | "odt" => read_zip_text(&bytes, |name| {
            name == "word/document.xml" || name == "content.xml"
        })?,
        "xlsx" | "ods" => read_zip_text(&bytes, |name| {
            name.contains("sharedStrings") || name.contains("worksheets/") || name == "content.xml"
        })?,
        "pptx" | "odp" => read_zip_text(&bytes, |name| {
            name.contains("ppt/slides/") || name == "content.xml"
        })?,
        "zip" | "7z" | "rar" | "tar" | "gz" | "tgz" => archive_listing(&bytes)?,
        _ => String::from_utf8(bytes)
            .map_err(|_| "file-format-not-readable")
            .map(trim_output)?,
    };
    if content.trim().is_empty() {
        return Err("file-readable-content-missing");
    }
    Ok(ExtractFileContentResponse {
        content,
        format: ext,
    })
}

#[cfg(test)]
mod tests {
    use super::{extension, strip_xml};
    #[test]
    fn extracts_extensions_and_xml_text() {
        assert_eq!(extension("报告.PDF"), "pdf");
        assert_eq!(strip_xml("<w:t>你好</w:t><w:t>世界</w:t>"), "你好 世界");
    }
}

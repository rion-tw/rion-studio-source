use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use serde_json::Value;
use uuid::Uuid;

use crate::{
    database::LogDatabaseWorker,
    error::{CoreError, CoreResult},
    model::DiagnosticExportResultRecord,
};

enum ZipSource {
    Data(Vec<u8>),
    File(PathBuf),
}

struct ZipEntry {
    name: String,
    source: ZipSource,
}

struct CentralEntry {
    crc: u32,
    local_offset: u32,
    name: Vec<u8>,
    size: u32,
}

pub fn export_bundle(
    output_path: &Path,
    diagnostics: &Value,
    logs: &LogDatabaseWorker,
) -> CoreResult<DiagnosticExportResultRecord> {
    if !output_path.is_absolute() {
        return Err(CoreError::InvalidInput(
            "Diagnostic export path must be absolute.".to_owned(),
        ));
    }
    let parent = output_path.parent().ok_or_else(|| {
        CoreError::InvalidInput("Diagnostic export path has no parent.".to_owned())
    })?;
    fs::create_dir_all(parent).map_err(io_error)?;
    let suffix = Uuid::new_v4();
    let temporary_path = parent.join(format!(".rion-diagnostics-{suffix}.tmp"));
    let log_export_path = parent.join(format!(".rion-diagnostics-{suffix}.jsonl"));

    let result = (|| {
        logs.export_jsonl_to(log_export_path.clone())?;
        let diagnostics_bytes = serde_json::to_vec_pretty(diagnostics)
            .map_err(|error| CoreError::Internal(error.to_string()))?;
        write_zip(
            &temporary_path,
            vec![
                ZipEntry {
                    name: "diagnostics.json".to_owned(),
                    source: ZipSource::Data(diagnostics_bytes),
                },
                ZipEntry {
                    name: "logs/rion-studio-logs.jsonl".to_owned(),
                    source: ZipSource::File(log_export_path.clone()),
                },
            ],
        )?;
        rion_platform::atomic_replace_file(&temporary_path, output_path)
            .map_err(|error| CoreError::Platform(error.to_string()))?;
        Ok(DiagnosticExportResultRecord {
            file_path: output_path.to_string_lossy().into_owned(),
            log_file_count: 1,
        })
    })();

    let _ = fs::remove_file(&temporary_path);
    let _ = fs::remove_file(&log_export_path);
    result
}

fn write_zip(path: &Path, entries: Vec<ZipEntry>) -> CoreResult<()> {
    if entries.len() > u16::MAX as usize {
        return Err(CoreError::InvalidInput(
            "Diagnostic ZIP contains too many entries.".to_owned(),
        ));
    }
    let mut output = File::create(path).map_err(io_error)?;
    let mut central = Vec::with_capacity(entries.len());
    let mut output_offset = 0_u64;

    for entry in entries {
        let name = entry.name.replace('\\', "/").into_bytes();
        let local_offset = u32::try_from(output_offset)
            .map_err(|_| CoreError::Internal("Diagnostic ZIP exceeds ZIP32.".to_owned()))?;
        let mut header = [0_u8; 30];
        put_u32(&mut header, 0, 0x0403_4b50);
        put_u16(&mut header, 4, 20);
        put_u16(&mut header, 6, 0x0808);
        put_u16(
            &mut header,
            26,
            u16::try_from(name.len())
                .map_err(|_| CoreError::InvalidInput("ZIP entry name is too long.".to_owned()))?,
        );
        output.write_all(&header).map_err(io_error)?;
        output.write_all(&name).map_err(io_error)?;
        output_offset = output_offset
            .saturating_add(header.len() as u64)
            .saturating_add(name.len() as u64);

        let mut crc = 0xffff_ffff;
        let mut size = 0_u64;
        match entry.source {
            ZipSource::Data(bytes) => {
                update_and_write(&mut output, &bytes, &mut crc, &mut size)?;
            }
            ZipSource::File(path) => {
                let mut input = File::open(path).map_err(io_error)?;
                let mut buffer = [0_u8; 64 * 1024];
                loop {
                    let read = input.read(&mut buffer).map_err(io_error)?;
                    if read == 0 {
                        break;
                    }
                    update_and_write(&mut output, &buffer[..read], &mut crc, &mut size)?;
                }
            }
        }
        let size = u32::try_from(size)
            .map_err(|_| CoreError::Internal("Diagnostic ZIP entry exceeds ZIP32.".to_owned()))?;
        let crc = crc ^ 0xffff_ffff;
        let mut descriptor = [0_u8; 16];
        put_u32(&mut descriptor, 0, 0x0807_4b50);
        put_u32(&mut descriptor, 4, crc);
        put_u32(&mut descriptor, 8, size);
        put_u32(&mut descriptor, 12, size);
        output.write_all(&descriptor).map_err(io_error)?;
        output_offset = output_offset
            .saturating_add(u64::from(size))
            .saturating_add(descriptor.len() as u64);
        central.push(CentralEntry {
            crc,
            local_offset,
            name,
            size,
        });
    }

    let central_offset = u32::try_from(output_offset)
        .map_err(|_| CoreError::Internal("Diagnostic ZIP exceeds ZIP32.".to_owned()))?;
    let mut central_size = 0_u64;
    for entry in &central {
        let mut header = [0_u8; 46];
        put_u32(&mut header, 0, 0x0201_4b50);
        put_u16(&mut header, 4, 20);
        put_u16(&mut header, 6, 20);
        put_u16(&mut header, 8, 0x0808);
        put_u32(&mut header, 16, entry.crc);
        put_u32(&mut header, 20, entry.size);
        put_u32(&mut header, 24, entry.size);
        put_u16(&mut header, 28, entry.name.len() as u16);
        put_u32(&mut header, 42, entry.local_offset);
        output.write_all(&header).map_err(io_error)?;
        output.write_all(&entry.name).map_err(io_error)?;
        central_size = central_size
            .saturating_add(header.len() as u64)
            .saturating_add(entry.name.len() as u64);
    }
    let central_size = u32::try_from(central_size)
        .map_err(|_| CoreError::Internal("Diagnostic ZIP exceeds ZIP32.".to_owned()))?;
    let mut end = [0_u8; 22];
    put_u32(&mut end, 0, 0x0605_4b50);
    put_u16(&mut end, 8, central.len() as u16);
    put_u16(&mut end, 10, central.len() as u16);
    put_u32(&mut end, 12, central_size);
    put_u32(&mut end, 16, central_offset);
    output.write_all(&end).map_err(io_error)?;
    output.sync_all().map_err(io_error)
}

fn update_and_write(
    output: &mut File,
    bytes: &[u8],
    crc: &mut u32,
    size: &mut u64,
) -> CoreResult<()> {
    for byte in bytes {
        *crc ^= u32::from(*byte);
        for _ in 0..8 {
            *crc = if *crc & 1 == 1 {
                0xedb8_8320 ^ (*crc >> 1)
            } else {
                *crc >> 1
            };
        }
    }
    output.write_all(bytes).map_err(io_error)?;
    *size = size.saturating_add(bytes.len() as u64);
    Ok(())
}

fn put_u16(buffer: &mut [u8], offset: usize, value: u16) {
    buffer[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32(buffer: &mut [u8], offset: usize, value: u32) {
    buffer[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn io_error(error: std::io::Error) -> CoreError {
    CoreError::Platform(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::LogDatabaseWorker;

    #[test]
    fn streams_logs_and_atomically_installs_a_standard_zip() {
        let directory = tempfile::tempdir().unwrap();
        let logs_path = directory.path().join("logs.sqlite3");
        let logs = LogDatabaseWorker::start(logs_path).unwrap();
        let output = directory.path().join("diagnostics.zip");
        let result = export_bundle(&output, &serde_json::json!({"ok": true}), &logs).unwrap();
        crate::v1_case!("logging-eb62819bea2f", {
            assert_eq!(result.log_file_count, 1);
            let bytes = fs::read(output).unwrap();
            assert_eq!(&bytes[..4], &0x0403_4b50_u32.to_le_bytes());
            assert!(bytes.windows(16).any(|part| part == b"diagnostics.json"));
            assert!(bytes.windows(10).any(|part| part == b"logs.jsonl"));
            assert_eq!(
                &bytes[bytes.len() - 22..bytes.len() - 18],
                &0x0605_4b50_u32.to_le_bytes()
            );
        });
    }

    #[test]
    fn rejects_relative_output_without_leaving_temporary_files() {
        let directory = tempfile::tempdir().unwrap();
        let logs = LogDatabaseWorker::start(directory.path().join("logs.sqlite3")).unwrap();
        assert!(export_bundle(Path::new("diagnostics.zip"), &Value::Null, &logs).is_err());
        assert!(fs::read_dir(directory.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("diagnostics-")
        }));
    }
}

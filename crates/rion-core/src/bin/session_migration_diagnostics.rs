//! Test-feature-only entry. No AppCore is opened against a user's database.
use std::io::{Read, Write};

fn main() {
    let mut bytes = Vec::new();
    let result = std::io::stdin()
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "REQUEST_READ_FAILED")
        .and_then(|_| {
            if bytes.len() > 1024 * 1024 {
                return Err("REQUEST_TOO_LARGE");
            }
            rion_core::migration_diagnostics::run(&bytes)
        });
    match result {
        Ok(report) => {
            if std::io::stdout().write_all(&report).is_err() {
                std::process::exit(1);
            }
        }
        Err(code) => {
            eprintln!("{code}");
            std::process::exit(1);
        }
    }
}

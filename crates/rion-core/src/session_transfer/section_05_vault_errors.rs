fn vault_error(code: &'static str, message: &'static str) -> CoreError {
    transfer_error(code, message)
}

fn vault_path_error() -> CoreError {
    vault_error(
        "ROLE_SESSION_TRANSFER_VAULT_PATH_INVALID",
        "Session-transfer vault path validation failed.",
    )
}

fn vault_not_found_error() -> CoreError {
    vault_error(
        "ROLE_SESSION_TRANSFER_VAULT_NOT_FOUND",
        "Session-transfer vault inventory is not available.",
    )
}

fn vault_file_error() -> CoreError {
    vault_error(
        "ROLE_SESSION_TRANSFER_VAULT_FILE_INVALID",
        "Session-transfer vault inventory is not a trusted regular file.",
    )
}

fn vault_size_error() -> CoreError {
    vault_error(
        "ROLE_SESSION_TRANSFER_VAULT_SIZE_INVALID",
        "Session-transfer vault inventory exceeds its encrypted size boundary.",
    )
}

fn vault_permissions_error() -> CoreError {
    vault_error(
        "ROLE_SESSION_TRANSFER_VAULT_PERMISSIONS_INVALID",
        "Session-transfer vault permissions could not be restricted.",
    )
}

fn vault_io_error() -> CoreError {
    vault_error(
        "ROLE_SESSION_TRANSFER_VAULT_IO_FAILED",
        "Session-transfer vault storage failed.",
    )
}

fn vault_protection_error() -> CoreError {
    vault_error(
        "ROLE_SESSION_TRANSFER_VAULT_PROTECTION_FAILED",
        "Session-transfer vault protection failed.",
    )
}

fn vault_authentication_error() -> CoreError {
    vault_error(
        "ROLE_SESSION_TRANSFER_VAULT_AUTHENTICATION_FAILED",
        "Session-transfer vault authentication failed.",
    )
}

fn vault_journal_identity_error() -> CoreError {
    vault_error(
        "ROLE_SESSION_TRANSFER_VAULT_JOURNAL_IDENTITY_MISMATCH",
        "Session-transfer vault identity does not match its migration journal.",
    )
}

fn vault_journal_state_error() -> CoreError {
    vault_error(
        "ROLE_SESSION_TRANSFER_VAULT_JOURNAL_STATE_INVALID",
        "Session-transfer vault creation is not valid for the migration journal state.",
    )
}

fn vault_journal_evidence_missing_error() -> CoreError {
    vault_error(
        "ROLE_SESSION_TRANSFER_VAULT_JOURNAL_EVIDENCE_MISSING",
        "Session-transfer vault evidence is not committed in the migration journal.",
    )
}

fn vault_journal_evidence_mismatch_error() -> CoreError {
    vault_error(
        "ROLE_SESSION_TRANSFER_VAULT_JOURNAL_EVIDENCE_MISMATCH",
        "Session-transfer vault evidence does not match the migration journal.",
    )
}

fn vault_conflict_error() -> CoreError {
    vault_error(
        "ROLE_SESSION_TRANSFER_VAULT_CONFLICT",
        "Session-transfer vault already contains a conflicting inventory.",
    )
}

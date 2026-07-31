# Data and Persistence

- Metadata lives in `rion-studio.sqlite3` under the shared app-data directory.
- High-volume logs live in `logs.sqlite3`.
- Each role owns `roles/{roleId}/browser`; never store account passwords.
- Rust validates and normalizes inputs and commits related mutations in one
  SQLite transaction.
- Portable import/export must be atomic. Failure preserves the destination and
  removes temporary files unless a recovery journal must remain.
- Unsupported database and portable versions fail closed without modifying or
  deleting the source data.
- Chrome Profile import staging is encrypted and bounded to cookies and exact
  launch-origin LocalStorage. Passwords, history, autofill, IndexedDB, extensions,
  and unrelated origins are out of scope.

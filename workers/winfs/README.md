# Windows original-project writeback gate

Safe writeback is intentionally unavailable (`supported: false`). No helper is
installed or advertised. Node filesystem writes cannot establish the Windows
exclusive sharing/handle conditions required for race-safe original writeback.

Enabling this capability requires an actual Windows helper using exclusive file
handles, baseline verification inside those handles, exclusive new-file creation,
backup and durable per-file recovery journal, plus real external-writer and crash
tests. Merely checking hashes before `writeFile` is insufficient. Managed copies
and exclusive new-directory export remain usable independently.

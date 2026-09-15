import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Never read or refresh the developer's real Codex login and configuration
// from unit tests. Individual tests populate this directory as needed.
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-walk-codex-home-'))

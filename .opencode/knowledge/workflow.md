# Local workflow

Local only: repository `ourapps-ae/holdem-rules` has no commits, pushes, remote changes or publishing without George's say-so. Licence wording remains deferred (`licenceStatus: "deferred"`).
Suite commands (from the package root): `node --test tests/server.test.ts tests/rules.test.ts tests/web.test.ts`; `python3 tests/native.py apple`; `python3 tests/native.py android`.
Review a fetched archive: `python3 -m aepm review <digest> --store STORE --policy POLICY --trusted --allow-network`.
Always run Python with `-B`; never write bytecode into the repository.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist/cli.js");
const sandbox = await mkdtemp(join(tmpdir(), "pr-sage-init-"));

try {
  await mkdir(join(sandbox, ".git"));
  const init = spawnSync(
    process.execPath,
    [
      cli,
      "init",
      "--yes",
      "--provider",
      "self-hosted",
      "--base-url",
      "http://ollama.internal:11434/v1",
    ],
    { cwd: sandbox, encoding: "utf8" },
  );
  assert.equal(init.status, 0, init.stderr);

  const config = JSON.parse(await readFile(join(sandbox, ".pr-sage.json"), "utf8"));
  assert.equal(config.provider, "openai");
  assert.equal(config.locale, "auto");

  const workflow = await readFile(
    join(sandbox, ".github/workflows/pr-sage.yml"),
    "utf8",
  );
  assert.match(workflow, /runs-on: self-hosted/);
  assert.match(workflow, /github\.event\.pull_request\.base\.sha/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /openai-base-url: http:\/\/ollama\.internal:11434\/v1/);

  const doctor = spawnSync(process.execPath, [cli, "doctor"], {
    cwd: sandbox,
    encoding: "utf8",
    env: { ...process.env, OPENAI_BASE_URL: "http://ollama.internal:11434/v1" },
  });
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  assert.match(doctor.stdout, /✓ trusted config/);
  assert.match(doctor.stdout, /✓ concurrency/);

  console.log("init/doctor E2E passed");
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

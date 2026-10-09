/**
 * Preload that reports the CPU time a process used, start to exit.
 *
 * Loaded through NODE_OPTIONS (`--import`), so it rides into every Node
 * process a build starts — `az build` and any child it spawns, such as the
 * image resizer. Each writes `<pid>.json` with its user + system CPU, across
 * all its threads and from process start (startup and module loading count),
 * into the directory AZ_TEST_CPU_DIR names. A test sums them: the build's own
 * cost, which — unlike wall-clock time — leaves out the time spent waiting
 * while whatever else the machine is running has the CPU.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.AZ_TEST_CPU_DIR;
if (!dir) throw new Error('cpu-time.mjs: AZ_TEST_CPU_DIR names no directory to report into');

process.on('exit', () => {
  const { user, system } = process.cpuUsage();
  writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ ms: (user + system) / 1000 }));
});

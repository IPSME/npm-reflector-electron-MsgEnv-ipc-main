// Integration test against the REAL macOS NSDNC messaging environment
// (@ipsme/msgenv-electron-nsdnc, over NSDistributedNotificationCenter).
//
// Unlike MQTT -- a plain TCP client that runs fine in node -- NSDNC calls Electron main-process
// APIs (systemPreferences.postNotification / subscribeNotification) that exist only inside an
// Electron main process on darwin. So this spec can't drive the loop in-process; instead it
// spawns the electron binary on spec/support/nsdnc_roundtrip_main.js, which runs the real
// round-trip and prints a single `RESULT:<json>` line. This spec parses that and asserts on it.
//
// Two-part gating, so the suite passes on any machine:
//   1. not darwin, or electron not installed  -> specs pend (skipped, not failed);
//   2. darwin + electron present               -> the child runs the real NSDNC round-trip.

const { spawn } = require('child_process');
const path = require('path');

// In plain node, `require('electron')` resolves to the binary path string (or throws if the
// optional dep isn't installed). That's exactly what we spawn.
let electron_bin = null;
try { electron_bin = require('electron'); } catch (e) { electron_bin = null; }

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'spec', 'support', 'nsdnc_roundtrip_main.js');
const can_run = process.platform === 'darwin' && typeof electron_bin === 'string';
const SKIP_REASON = process.platform !== 'darwin'
	? `NSDNC is macOS-only (platform is '${process.platform}')`
	: 'electron devDependency not installed';

// Run the Electron entry once; resolve with the parsed RESULT object (or an {error}).
function run_child() {
	return new Promise((resolve) => {
		const child = spawn(electron_bin, [ENTRY], { cwd: ROOT });
		let out = '';
		child.stdout.on('data', (d) => { out += d.toString(); });
		child.stderr.on('data', () => { /* electron chatter -- ignore */ });
		const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 25000);
		child.on('close', () => {
			clearTimeout(kill);
			const line = out.split('\n').find((l) => l.startsWith('RESULT:'));
			if (! line) { resolve({ error: 'no RESULT line from Electron child; stdout was:\n' + out }); return; }
			try { resolve(JSON.parse(line.slice('RESULT:'.length))); }
			catch (e) { resolve({ error: 'unparseable RESULT: ' + line }); }
		});
	});
}

(can_run ? describe : xdescribe)('Reflector_IPC_main <-> real macOS NSDNC', () => {
	let result;
	let saved_timeout;

	beforeAll(async () => {
		saved_timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
		jasmine.DEFAULT_TIMEOUT_INTERVAL = 30000;
		result = await run_child();
	});

	afterAll(() => { jasmine.DEFAULT_TIMEOUT_INTERVAL = saved_timeout; });

	it('round-trips a renderer message through NSDNC back to the window', () => {
		if (! can_run) { pending(SKIP_REASON); return; }
		expect(result.error).toBeUndefined();
		expect(result.roundtrip && result.roundtrip.ok)
			.withContext('window never received the message via NSDNC -- ' + JSON.stringify(result))
			.toBe(true);
	});

	it('suppresses a renderer echo of a message just delivered from NSDNC', () => {
		if (! can_run) { pending(SKIP_REASON); return; }
		expect(result.error).toBeUndefined();
		expect(result.dedup && result.dedup.ok)
			.withContext('dedup failed -- ' + JSON.stringify(result && result.dedup))
			.toBe(true);
	});
});

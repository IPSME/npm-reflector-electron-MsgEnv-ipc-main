// Unit tests -- no broker. Exercises the shipped CJS bundle (dist/) against mock messaging
// environments, so they run anywhere. The real MQTT round-trip lives in the integration spec.

const { Reflector_IPC_main, logr } = require('../dist/reflector-ipc-main.cjs.js');
const { LOGR, l_array } = require('@knev/bitlogr');

// A minimal ipcMain double: remembers the channel->handler registrations.
function make_ipcMain() {
	const handlers = {};
	return { handlers, on: (channel, fn) => { handlers[channel] = fn; } };
}

// A minimal messaging-environment double satisfying the injection contract.
function make_env(extra) {
	return Object.assign({ publish() {}, subscribe() {}, config: {} }, extra);
}

describe('Reflector_IPC_main -- constructor guard', () => {
	const ipc = make_ipcMain();

	it('throws when msgEnv is explicitly null (default param only covers omitted)', () => {
		expect(() => new Reflector_IPC_main(ipc, null))
			.toThrowError(/must expose \.publish/);
	});

	it('throws when msgEnv lacks .publish', () => {
		expect(() => new Reflector_IPC_main(ipc, { subscribe() {} }))
			.toThrowError(/must expose \.publish/);
	});

	it('throws when msgEnv lacks .subscribe', () => {
		expect(() => new Reflector_IPC_main(ipc, { publish() {} }))
			.toThrowError(/must expose .*\.subscribe/);
	});

	it('constructs with a valid injected env', () => {
		expect(() => new Reflector_IPC_main(ipc, make_env())).not.toThrow();
	});
});

describe('Reflector_IPC_main -- injection overrides the OS default', () => {
	it('routes renderer messages to the injected env.publish', () => {
		const published = [];
		const env = make_env({ publish: (m) => published.push(m) });
		const r = new Reflector_IPC_main(make_ipcMain(), env);

		r.handler_ipc(null, 'to-mqtt');

		expect(published).toEqual(['to-mqtt']);
	});

	it('wires ipcMain.on and env.subscribe on subscribe()', () => {
		let subscribed = false;
		const env = make_env({ subscribe: () => { subscribed = true; } });
		const ipc = make_ipcMain();
		const r = new Reflector_IPC_main(ipc, env);

		r.subscribe();

		expect(typeof ipc.handlers['ipc-reflector-to-main']).toBe('function');
		expect(subscribed).toBe(true);
	});
});

describe('Reflector_IPC_main -- per-instance logger wire (feature-detect)', () => {
	it('uses only the reflector labels when the env exposes no v3 logr', () => {
		const r = new Reflector_IPC_main(make_ipcMain(), make_env());

		expect(r._l.DUPLICATES).toBeGreaterThan(0);
		expect(r._l.CONNECTIONS).toBeGreaterThan(0);
		expect(r._l.REFLECTION).toBeGreaterThan(0);
		// an env label that was never wired resolves to nothing
		expect(r._l.ENV_A).toBeFalsy();
	});

	it('unions the configured env logr into a shared, collision-free mask', () => {
		const env_logr = LOGR.get_instance().create({ name: 'MockEnv', labels: l_array(['ENV_A', 'ENV_B']) });
		const r = new Reflector_IPC_main(make_ipcMain(), make_env({ logr: env_logr }));

		// reflector's own labels still present...
		expect(r._l.REFLECTION).toBeGreaterThan(0);
		// ...and the env's labels merged in...
		expect(r._l.ENV_A).toBeGreaterThan(0);
		expect(r._l.ENV_B).toBeGreaterThan(0);
		// ...with no two labels sharing a bit
		const bits = [r._l.DUPLICATES, r._l.CONNECTIONS, r._l.REFLECTION, r._l.ENV_A, r._l.ENV_B];
		expect(new Set(bits).size).toBe(bits.length);
	});

	it('exports a usable module-level logr handle', () => {
		expect(typeof logr.log).toBe('function');
	});
});

describe('Reflector_IPC_main -- dedup (idempotence across the IPC/ME loop)', () => {
	it('suppresses a renderer echo of a message already seen from the ME', () => {
		const published = [];
		const env = make_env({ publish: (m) => published.push(m) });
		const r = new Reflector_IPC_main(make_ipcMain(), env);

		// a message arrives from the ME -> cached, fanned out to windows
		r.handler_MsgEnv('m1');
		// the renderer echoes the same message back over IPC -> must NOT be re-published
		r.handler_ipc(null, 'm1');
		expect(published).toEqual([]);

		// a genuinely new renderer message IS published
		r.handler_ipc(null, 'm2');
		expect(published).toEqual(['m2']);
	});
});

describe('Reflector_IPC_main -- window fan-out', () => {
	function make_window(destroyed, sink) {
		return {
			isDestroyed: () => destroyed,
			webContents: { send: (channel, m) => sink.push([channel, m]) }
		};
	}

	it('sends ME messages to every live window and skips destroyed ones', () => {
		const live_sink = [];
		const dead_sink = [];
		const r = new Reflector_IPC_main(make_ipcMain(), make_env());
		r.add_window(make_window(false, live_sink));
		r.add_window(make_window(true, dead_sink));

		// the destroyed window trips the reflector's defensive console.assert -- spy on it so it
		// doesn't spew to stderr, and assert the guard actually fired for the bad handle.
		const assert_spy = spyOn(console, 'assert');

		r.handler_MsgEnv('broadcast');

		expect(live_sink).toEqual([['ipc-reflector-to-window', 'broadcast']]);
		expect(dead_sink).toEqual([]);
		expect(assert_spy).toHaveBeenCalledWith(false, jasmine.any(String));
	});

	it('stops sending to a removed window', () => {
		const sink = [];
		const win = make_window(false, sink);
		const r = new Reflector_IPC_main(make_ipcMain(), make_env());
		r.add_window(win);
		r.remove_window(win);

		r.handler_MsgEnv('after-remove');

		expect(sink).toEqual([]);
	});
});

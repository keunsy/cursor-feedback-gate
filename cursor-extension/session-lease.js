/**
 * Multi-window session leases.
 *
 * Background: Cursor's globalState is application-wide. This extension scopes
 * persisted sessions by workspace paths, so two windows opening the SAME
 * workspace restore the SAME sessions (same keys, same sessionIds) and both
 * believe they own them. Without arbitration the trigger popup opens in a
 * random window, and input typed into the non-holder window's copy of the
 * session is enqueued into a dead-end queue file that nobody drains — the
 * MCP server never receives the reply.
 *
 * Mechanism: when a window claims a trigger for a session it writes a lease
 * file (feedback_gate_lease_<sessionId>.json) containing its extension-host
 * PID and a timestamp. Other windows defer routing for that session while
 * the lease is fresh (< LEASE_MAX_AGE_MS) and the holder process is alive.
 * The holder refreshes the lease periodically; closing/cleaning a session
 * removes it. A crashed holder's lease simply expires and the file is
 * cleaned on startup.
 */
const fs = require('fs');
const { getTempPath } = require('./utils');

const LEASE_MAX_AGE_MS = 60 * 1000;         // lease must be refreshed within 60s
const LEASE_REFRESH_INTERVAL_MS = 30 * 1000; // holder rewrites every 30s

function _defaultAliveProbe(pid) {
    if (!pid || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) {
        return e.code !== 'ESRCH';
    }
}

// Injectable for tests.
let _aliveProbe = _defaultAliveProbe;
function _setAliveProbe(fn) { _aliveProbe = fn || _defaultAliveProbe; }

function getLeasePath(sessionId) {
    return getTempPath(`feedback_gate_lease_${sessionId}.json`);
}

function writeLease(sessionId, ehPid, sessionKey) {
    if (!sessionId || !ehPid) return false;
    try {
        const leaseFile = getLeasePath(sessionId);
        const tmp = leaseFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({
            session_id: sessionId,
            eh_pid: ehPid,
            session_key: sessionKey || '',
            ts: Date.now(),
        }, null, 2));
        fs.renameSync(tmp, leaseFile);
        return true;
    } catch (e) {
        console.log(`Feedback Gate: failed to write session lease for ${sessionId}: ${e.message}`);
        return false;
    }
}

function readLease(sessionId) {
    if (!sessionId) return null;
    try {
        const data = JSON.parse(fs.readFileSync(getLeasePath(sessionId), 'utf8'));
        if (!data || typeof data.eh_pid !== 'number' || typeof data.ts !== 'number') return null;
        return data;
    } catch { return null; }
}

/**
 * True when ANOTHER live window currently holds the lease for this session.
 * Own leases, dead holders and stale leases all return false (claimable).
 */
function isHeldElsewhere(sessionId, myPid, now) {
    const lease = readLease(sessionId);
    if (!lease || lease.eh_pid === myPid) return false;
    if ((now || Date.now()) - lease.ts > LEASE_MAX_AGE_MS) return false;
    return _aliveProbe(lease.eh_pid);
}

/**
 * Remove the lease file only if WE hold it. Never delete another window's
 * valid lease (a stale one is simply ignored by readers and cleaned later).
 */
function removeOwnLease(sessionId, myPid) {
    if (!sessionId) return;
    try {
        const lease = readLease(sessionId);
        if (lease && lease.eh_pid !== myPid) return;
        fs.unlinkSync(getLeasePath(sessionId));
    } catch {}
}

/**
 * Startup cleanup: unlink leases whose holder is dead or whose timestamp is
 * hopelessly stale. Safe to run from any window — it only removes leases
 * that no reader would honour anyway.
 */
function cleanStaleLeases(now) {
    try {
        const dir = getTempPath('');
        const files = fs.readdirSync(dir).filter(f => f.startsWith('feedback_gate_lease_') && f.endsWith('.json'));
        for (const f of files) {
            try {
                const fullPath = getTempPath(f);
                const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
                const stale = !data || typeof data.ts !== 'number'
                    || (now - data.ts) > 24 * 3600 * 1000;
                const dead = data && typeof data.eh_pid === 'number' && !_aliveProbe(data.eh_pid);
                if (stale || dead) fs.unlinkSync(fullPath);
            } catch {}
        }
    } catch {}
}

module.exports = {
    LEASE_MAX_AGE_MS,
    LEASE_REFRESH_INTERVAL_MS,
    getLeasePath,
    writeLease,
    readLease,
    isHeldElsewhere,
    removeOwnLease,
    cleanStaleLeases,
    _setAliveProbe,
};

// Sign Lyra in to YouTube, once (2026-11-24): opens Google's sign-in in the browser; Chris signs in with LYRA's Google
// account (the channel she comments as) and presses Allow. The refresh token is saved in data/youtube/token.json.
// Run: node src/youtube-signin.js   (or "Sign in Lyra YouTube.bat")
import http from 'node:http';
import { exec } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { oauthClient, saveToken, SCOPE } from './yt-channel.js';

const c = (() => { try { return oauthClient(); } catch (err) { console.error(`\n${err.message}\n`); process.exit(1); } })();
const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(16).toString('hex');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (!url.searchParams.has('code') && !url.searchParams.has('error')) { res.writeHead(404).end(); return; }
  const done = (msg) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<p style="font:18px system-ui;margin:40px">${msg}</p>`); };
  if (url.searchParams.get('state') !== state || url.searchParams.get('error')) {
    done(`Sign-in didn't finish (${url.searchParams.get('error') || 'state mismatch'}). Close this and run it again.`);
    console.error('Sign-in failed:', url.searchParams.get('error') || 'state mismatch');
    server.close(); process.exitCode = 1; return;
  }
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: url.searchParams.get('code'), client_id: c.client_id, client_secret: c.client_secret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }),
    });
    const j = await r.json();
    if (!r.ok || !j.refresh_token) throw new Error(j.error_description || j.error || 'no refresh token returned');
    // signedInAt: in Google's Testing mode the sign-in lasts 7 days; the Health page counts down from here
    saveToken({ refresh_token: j.refresh_token, access_token: j.access_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, signedInAt: Date.now() });
    const me = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${j.access_token}` } }).then((x) => x.json());
    const name = me.items?.[0]?.snippet?.title;
    done(name ? `Lyra is signed in to YouTube as <b>${name.replace(/</g, '&lt;')}</b>. You can close this tab.` : 'Signed in, but this Google account has no YouTube channel. Sign in again with Lyra\'s account.');
    console.log(name ? `\nSigned in as "${name}". Done.\n` : '\nSigned in, but that account has no YouTube channel. Run it again with Lyra\'s account.\n');
  } catch (err) {
    done(`Sign-in failed: ${String(err.message).replace(/</g, '&lt;')}`);
    console.error('Sign-in failed:', err.message); process.exitCode = 1;
  }
  server.close();
});
let redirect;
server.listen(0, '127.0.0.1', () => {
  redirect = `http://127.0.0.1:${server.address().port}`;
  const auth = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: c.client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent',
    state, code_challenge: challenge, code_challenge_method: 'S256',
  })}`;
  console.log('\nOpening Google sign-in in your browser. Sign in with LYRA\'s Google account (the Data Center Confessions channel) and press Allow.\n');
  console.log(`If the browser doesn't open, paste this into it:\n${auth}\n`);
  exec(`start "" "${auth}"`, { shell: 'cmd.exe' });
});

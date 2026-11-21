// The magazine's email gate. Ash, Nov 20 2026: free through the opening letter, then an email to read on.
//
// WHAT THIS DOES NOT DO, on purpose: it sends nothing. No confirmation mail, no code, no click to verify.
// Her words: "I don't want to lose people this is low hanging traffic". So the address is checked here,
// in the request, and the reader is let through in the same breath.
//
// HOW AN ADDRESS IS CHECKED WITHOUT SENDING TO IT, cheapest test first:
//   1. shape        a real local part and domain, one @, a dotted TLD of 2+ letters, no stray dots
//   2. junk         test@test.com, a@a.com, asdf@asdf.com and friends
//   3. disposable   the big throwaway-inbox domains
//   4. MX           a DNS lookup over HTTPS for the domain's mail servers. This is the one that matters:
//                   a domain with no MX and no A record cannot receive mail, so the address cannot be real.
//   5. typo         gmial.com and its cousins come back as a suggestion rather than a rejection, because a
//                   typo is a reader we would otherwise lose, not a fake.
//
// Storage is Resend. Her plan allows three segments and all three are taken, so magazine readers are not a
// fourth: they go in General, carry source=magazine, and are opted into the Magazine topic, which is what
// gives them a one-click unsubscribe from the magazine alone. That is what makes the no-spam promise real
// rather than decorative.
const SEGMENT_GENERAL = 'db3c6cb8-2806-4855-b3ee-9e929834a09e';
const TOPIC_MAGAZINE = 'cc51e017-e544-4c28-bf5e-e82eb6e09692';

const SHAPE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

const JUNK = new Set(['test.com', 'test.test', 'example.com', 'example.org', 'email.com', 'domain.com', 'asdf.com', 'aaa.com', 'a.com', 'none.com', 'no.com', 'fake.com', 'nope.com']);
const JUNK_LOCAL = new Set(['test', 'asdf', 'asdfasdf', 'qwerty', 'aaa', 'aaaa', 'abc', 'abcd', 'x', 'xx', 'xxx', 'a', 'none', 'fake', 'noemail', 'no']);

const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', '10minutemail.com',
  '10minutemail.net', 'tempmail.com', 'temp-mail.org', 'throwawaymail.com', 'yopmail.com', 'yopmail.fr',
  'getnada.com', 'nada.email', 'trashmail.com', 'dispostable.com', 'maildrop.cc', 'fakeinbox.com',
  'mailnesia.com', 'mytemp.email', 'moakt.com', 'tempr.email', 'emailondeck.com', 'spamgourmet.com',
  'mohmal.com', 'inboxkitten.com', 'burnermail.io', 'temp-mail.io', 'mailsac.com', 'harakirimail.com',
  'tmpmail.org', 'tmpmail.net', 'luxusmail.org', 'vomoto.com', 'einrot.com', 'dropmail.me',
]);

// A near-miss of a big provider is almost always a typo, and a typo is a reader, not a fake.
const COMMON = ['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'comcast.net', 'verizon.net', 'msn.com', 'sbcglobal.net'];
function near(domain) {
  for (const c of COMMON) {
    if (c === domain) return null;
    if (Math.abs(c.length - domain.length) > 2) continue;
    // Levenshtein, bounded at 2
    const a = domain, b = c;
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let diag = prev[0]; prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const t = prev[j];
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
        diag = t;
      }
    }
    if (prev[b.length] <= 2) return c;
  }
  return null;
}

// Can this domain receive mail at all? MX first, then A: some small domains take mail on the A record.
async function canReceive(domain) {
  const ask = async (type) => {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`,
      { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('dns');
    const j = await r.json();
    return Array.isArray(j.Answer) && j.Answer.some((x) => x.type === (type === 'MX' ? 15 : 1));
  };
  try {
    if (await ask('MX')) return true;
    return await ask('A');
  } catch (e) {
    // The lookup itself failed. Do not punish the reader for our network: let them in.
    return true;
  }
}

const send = (res, code, body) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) { chunks.push(c); if (chunks.reduce((a, b) => a + b.length, 0) > 8192) break; }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { return {}; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  try {
    const b = await readBody(req);

    // A hidden field no person can see. A bot fills it, and gets a cheerful nothing.
    if (String(b.website || '').trim()) return send(res, 200, { ok: true });

    const raw = String(b.email || '').trim();
    const email = raw.toLowerCase();
    if (!email) return send(res, 400, { error: 'Add your email to keep reading.' });
    if (email.length > 254 || !SHAPE.test(email)) return send(res, 400, { error: 'That email does not look right.' });

    const [local, domain] = email.split('@');
    if (JUNK.has(domain) || JUNK_LOCAL.has(local)) return send(res, 400, { error: 'That email does not look right.' });
    if (DISPOSABLE.has(domain)) return send(res, 400, { error: 'That looks like a temporary inbox. Use one you actually read.' });

    if (!(await canReceive(domain))) {
      const s = near(domain);
      return send(res, 400, s
        ? { error: `Did you mean ${local}@${s}?`, suggest: `${local}@${s}` }
        : { error: 'We could not find that email provider. Check the spelling after the @.' });
    }

    const key = process.env.RESEND_API_KEY;
    if (!key) { console.error('sub: RESEND_API_KEY is not set'); return send(res, 500, { error: 'Could not save that right now. Try again in a minute.' }); }

    const r = await fetch('https://api.resend.com/contacts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        unsubscribed: false,
        segmentIds: [SEGMENT_GENERAL],
        topics: [{ id: TOPIC_MAGAZINE, subscription: 'opt_in' }],
        properties: { source: 'magazine' },
      }),
      signal: AbortSignal.timeout(8000),
    });

    // An address already on the list is a returning reader, not an error. Let them straight through.
    if (!r.ok && r.status !== 409 && r.status !== 422) {
      console.error('sub: resend', r.status, (await r.text()).slice(0, 300));
      return send(res, 500, { error: 'Could not save that right now. Try again in a minute.' });
    }
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('sub', e);
    return send(res, 500, { error: 'Could not save that right now. Try again in a minute.' });
  }
}

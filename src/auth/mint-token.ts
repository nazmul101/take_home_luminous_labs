import { signToken } from './jwt.js';

// Tiny CLI so the endpoint can actually be exercised by hand:
//   npm run token -- 2          -> token for user 2
//   npm run token -- 1 admin    -> admin token
//
// There is no login endpoint, and that is a deliberate omission: the brief asks
// who may read an order history, not how credentials are exchanged.

const [idArg, roleArg = 'user'] = process.argv.slice(2);
const id = Number(idArg);

if (!Number.isInteger(id) || id <= 0) {
  console.error('usage: npm run token -- <userId> [user|admin]');
  process.exit(1);
}

if (roleArg !== 'user' && roleArg !== 'admin') {
  console.error('role must be "user" or "admin"');
  process.exit(1);
}

console.log(signToken({ id, role: roleArg }));

import { buildQrPayload, parseQrPayload } from '../../src/lib/qb/omr-template';
import { createHash } from 'crypto';

const p = buildQrPayload('cmTestVersion123', 'T-cmTestVersion123', 0, 1);
console.log('v2 payload:', p);
console.log('TS parse:', JSON.stringify(parseQrPayload(p)));
const bad = p.slice(0, -2) + 'ZZ';
console.log('tampered accepted?:', parseQrPayload(bad) !== null);
const v1 =
  'ANQB|1|cmOldVersion|T-cmOldVersion|0|1|' +
  createHash('sha256').update('cmOldVersion|T-cmOldVersion|0').digest('hex').slice(0, 8).toUpperCase();
console.log('v1 accepted:', parseQrPayload(v1) !== null);

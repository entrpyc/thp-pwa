/**
 * The negative control for tools/mail-boundary.ts. A second door to the outside world: a module
 * that is not the transports file and imports a mail library anyway.
 */
import { createTransport } from 'nodemailer';

export const leaked = createTransport({ host: 'localhost', port: 25 });

import { run } from './entry.js';

process.exitCode = await run(process.argv.slice(2));

import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),root=path.dirname(fileURLToPath(import.meta.url));
await require('esbuild').build({entryPoints:[path.join(root,'client/main.jsx')],outfile:path.join(root,'public/app.js'),bundle:true,external:['/fonts/*'],format:'esm',platform:'browser',target:'chrome110',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},sourcemap:false,minify:false});
console.log('Comic Studio browser app built');

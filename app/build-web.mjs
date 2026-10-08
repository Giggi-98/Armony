// Copia client/ in www/ per l'app: il client servito dal server resta com'è.
// Aggiunge window.ARMONY_APP (versione e repository), per il controllo degli aggiornamenti dell'APK.
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const root = new URL('..', import.meta.url).pathname, www = new URL('www', import.meta.url).pathname;
rmSync(www, { recursive: true, force: true });
cpSync(root + 'client', www, { recursive: true, filter: f => !/\/sw\.js$|\/manifest\.json$/.test(f) });
const version = readFileSync(root + 'VERSION', 'utf8').trim();
// da dove l'app controlla i suoi aggiornamenti: il repository della Action che la costruisce, o quello di Armony
const repo = process.env.GITHUB_REPOSITORY || 'Giggi-98/Armony';
const html = readFileSync(www + '/index.html', 'utf8');
if (!html.includes('<script src="armony.js">')) throw new Error('index.html: manca <script src="armony.js">');
writeFileSync(www + '/index.html', html.replace('<script src="armony.js">', `<script>window.ARMONY_APP = ${JSON.stringify({ version, repo })};</script>\n<script src="armony.js">`));
console.log(`www/ pronta, app ${version}`);

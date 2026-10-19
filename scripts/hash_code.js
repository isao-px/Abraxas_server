// Génère la valeur de UPLOAD_CODE_HASH à partir d'un code d'accès.
//   node scripts/hash_code.js            (le code est demandé, sans écho)
//   node scripts/hash_code.js "mon code" (pratique pour les essais, mais le code reste dans l'historique du shell)
import readline from 'node:readline';
import { hashCode } from '../lib/auth.js';

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = rl._writeToOutput.bind(rl);
  let prompted = false;
  rl._writeToOutput = (s) => {
    if (!prompted) {
      write(s);
      prompted = true;
    }
  };
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

let code = process.argv[2];
if (code === undefined) {
  if (!process.stdin.isTTY) {
    console.error('Donne le code en argument ou lance le script dans un terminal.');
    process.exit(1);
  }
  code = await ask("Code d'accès : ");
  const again = await ask('Confirme le code : ');
  if (again !== code) {
    console.error('Les deux codes sont différents.');
    process.exit(1);
  }
}
if (!code) {
  console.error('Code vide.');
  process.exit(1);
}
console.log(await hashCode(code));

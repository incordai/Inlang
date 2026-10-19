// Run: node packages/chat-instructions/examples/instructions-for-an-app.ts
import { buildInstructions } from '@az/chat-instructions/instructions.ts';

const system = buildInstructions({
  appName: 'Acme Lamps',
  components: ['faq', 'chart', 'cta'],
  destinations: ['/contact'],
  // The data source's queryable schema: public fields only.
  tables: [{ name: 'orders', fields: [{ name: 'status', type: 'choice', choices: ['paid', 'open'] }, { name: 'total', type: 'money', currency: 'usd' }] }],
  content: {
    site: { name: 'Acme Lamps', description: 'Desk lamps, built by hand.' },
    pages: [{ route: '/help', blocks: [{ block: 'faq', title: 'Questions', questions: [{ question: 'Do you ship abroad?', answer: 'Yes, to most countries.' }] }] }],
    notes: ['Orders ship within two working days.'],
  },
  rules: { extra: ['Answer in English, whatever language the question is in.'] },
  page: '/help',
});

// The fixed rules come first, then the content as data, then what this question changes.
const lines = system.split('\n');
console.log(lines[0]);
console.log(lines.find((l) => l.startsWith('- Answer in English')));
console.log(system.slice(system.indexOf('<site-content>'), system.indexOf('</site-content>') + '</site-content>'.length));
console.log(lines.find((l) => l.startsWith('The visitor is on the page')));
console.log(`${system.length} characters`);

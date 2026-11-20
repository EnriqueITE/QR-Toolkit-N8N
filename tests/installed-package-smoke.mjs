import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const consumerDirectory = process.argv[2];
assert.ok(consumerDirectory, 'Pass the path to the consumer project as the first argument.');
const consumerRequire = createRequire(resolve(consumerDirectory, 'package.json'));
const manifestPath = consumerRequire.resolve('@cyberace/n8n-nodes-qr/package.json');
const manifest = consumerRequire(manifestPath);
const { QrToolkit } = consumerRequire(resolve(dirname(manifestPath), manifest.n8n.nodes[0]));
const node = new QrToolkit();

async function execute(parameters) {
	const context = {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name, _index, fallback) => parameters[name] ?? fallback,
		getNode: () => ({ name: node.description.displayName, type: node.description.name }),
		continueOnFail: () => false,
	};
	const [[item]] = await node.execute.call(context);
	return item.json;
}

const content = 'QR Toolkit · installed package ✓';
const { dataUrl } = await execute({
	operation: 'generateQrCode',
	content,
	outputFormat: 'dataUrl',
});
assert.match(dataUrl, /^data:image\/png;base64,/);
const decoded = await execute({
	operation: 'readQrCode',
	inputSource: 'dataUrl',
	inputDataUrl: dataUrl,
});
assert.equal(decoded.qrContent, content);
console.log(
	`QR Toolkit ${manifest.version} generated and decoded a PNG on Node.js ${process.version}.`,
);

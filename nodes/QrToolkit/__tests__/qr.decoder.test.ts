/* eslint-disable @n8n/community-nodes/no-restricted-imports -- Test-only dependencies are excluded from the published package. */

import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import {
	decodeQrPng,
	generateQrMatrix,
	renderPng,
	type ErrorCorrectionLevel,
	type QrMatrix,
} from '../qr';

function render(matrix: QrMatrix, darkColor = '#000000', lightColor = '#FFFFFF'): Buffer {
	return renderPng(matrix, {
		width: 512,
		margin: 4,
		darkColor,
		lightColor,
	});
}

function rotateClockwise(matrix: QrMatrix): QrMatrix {
	const modules = Array.from({ length: matrix.size }, () => new Array<boolean>(matrix.size));
	for (let y = 0; y < matrix.size; y++) {
		for (let x = 0; x < matrix.size; x++) {
			modules[x]![matrix.size - 1 - y] = matrix.modules[y]![x]!;
		}
	}
	return { size: matrix.size, modules };
}

describe('QR PNG decoder', () => {
	it.each(['L', 'M', 'Q', 'H'] as const)('decodes generated content at level %s', async (level) => {
		const content = 'QR Toolkit read operation ' + level + ' — áéíóú 中文';
		const matrix = generateQrMatrix(content, level);

		const decoded = await decodeQrPng(render(matrix));

		expect(decoded).toMatchObject({
			content,
			version: (matrix.size - 17) / 4,
			errorCorrectionLevel: level,
		});
		expect(decoded.mask).toBeGreaterThanOrEqual(0);
		expect(decoded.mask).toBeLessThanOrEqual(7);
	});

	it.each([1, 2, 3])('decodes a PNG rotated by %s quarter turns', async (turns) => {
		const content = 'rotated QR';
		let matrix = generateQrMatrix(content, 'M');
		for (let turn = 0; turn < turns; turn++) matrix = rotateClockwise(matrix);

		await expect(decodeQrPng(render(matrix))).resolves.toMatchObject({ content });
	});

	it('decodes custom inverted colors', async () => {
		const content = 'inverted colors';
		const png = render(generateQrMatrix(content, 'Q'), '#FFFFFF', '#000000');

		await expect(decodeQrPng(png)).resolves.toMatchObject({
			content,
			errorCorrectionLevel: 'Q',
		});
	});

	it('decodes an 8-bit RGBA PNG', async () => {
		const content = 'RGBA PNG input';
		const indexed = render(generateQrMatrix(content, 'H'));
		const parsed = PNG.sync.read(indexed);
		const rgba = PNG.sync.write(parsed, { colorType: 6 });

		await expect(decodeQrPng(rgba)).resolves.toMatchObject({ content });
	});

	it('rejects non-PNG and blank images', async () => {
		await expect(decodeQrPng(Buffer.from('not an image'))).rejects.toThrow(
			'accepts PNG images only',
		);

		const blank = new PNG({ width: 128, height: 128 });
		blank.data.fill(255);
		await expect(decodeQrPng(PNG.sync.write(blank))).rejects.toThrow('enough contrast');
	});

	it('reads longer content and reports the selected version', async () => {
		const level: ErrorCorrectionLevel = 'M';
		const content = 'version-selection-'.repeat(30);
		const matrix = generateQrMatrix(content, level);

		await expect(decodeQrPng(render(matrix))).resolves.toMatchObject({
			content,
			version: (matrix.size - 17) / 4,
			errorCorrectionLevel: level,
		});
	});
});

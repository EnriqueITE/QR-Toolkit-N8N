/* eslint-disable @n8n/community-nodes/no-restricted-imports -- Dev-only decoder dependencies are excluded from the published package. */

import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { generateQrMatrix, renderPng, renderSvg, type ErrorCorrectionLevel } from '../qr';

const BLACK_AND_WHITE = {
	darkColor: '#000000',
	lightColor: '#FFFFFF',
	margin: 4,
};

function getVersion(content: string, level: ErrorCorrectionLevel): number {
	try {
		return (generateQrMatrix(content, level).size - 17) / 4;
	} catch {
		return 41;
	}
}

function contentForVersion(targetVersion: number, level: ErrorCorrectionLevel): string {
	let low = 1;
	let high = level === 'L' ? 2_953 : level === 'M' ? 2_331 : level === 'Q' ? 1_663 : 1_273;

	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (getVersion('A'.repeat(middle), level) < targetVersion) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}

	const content = 'A'.repeat(low);
	if (getVersion(content, level) !== targetVersion) {
		throw new Error(`Could not create deterministic content for QR version ${targetVersion}.`);
	}
	return content;
}

function decodePng(image: Buffer): string {
	const png = PNG.sync.read(image);
	const decoded = jsQR(Uint8ClampedArray.from(png.data), png.width, png.height);
	if (decoded === null) {
		throw new Error('The generated PNG could not be decoded as a QR code.');
	}
	return decoded.data;
}

describe('QR engine integration', () => {
	it('generates decodable PNGs for all 40 QR Model 2 versions', () => {
		for (let version = 1; version <= 40; version++) {
			const content = contentForVersion(version, 'M');
			const matrix = generateQrMatrix(content, 'M');
			const totalModules = matrix.size + BLACK_AND_WHITE.margin * 2;
			const image = renderPng(matrix, {
				...BLACK_AND_WHITE,
				width: totalModules * 4,
			});

			expect((matrix.size - 17) / 4).toBe(version);
			expect(decodePng(image)).toBe(content);
		}
	}, 120_000);

	it.each<ErrorCorrectionLevel>(['L', 'M', 'Q', 'H'])(
		'round-trips error correction level %s',
		(level) => {
			const content = `QR Toolkit ECC ${level}`;
			const matrix = generateQrMatrix(content, level);
			const image = renderPng(matrix, { ...BLACK_AND_WHITE, width: 257 });

			expect(decodePng(image)).toBe(content);
		},
	);

	it('round-trips UTF-8 content using ECI', () => {
		const content = 'Entrada v?lida: caf?, ??????, ??, ??';
		const matrix = generateQrMatrix(content, 'Q');
		const image = renderPng(matrix, { ...BLACK_AND_WHITE, width: 384 });

		expect(decodePng(image)).toBe(content);
	});

	it('renders custom colors and safe SVG geometry without encoded markup', () => {
		const malicious = '<script>alert("xss")</script>';
		const matrix = generateQrMatrix(malicious, 'M');
		const svg = renderSvg(matrix, {
			darkColor: '#123ABC',
			lightColor: '#FEDCBA',
			margin: 4,
			width: 512,
		});

		expect(svg).toContain('fill="#123ABC"');
		expect(svg).toContain('fill="#FEDCBA"');
		expect(svg).not.toContain(malicious);
		expect(svg).not.toContain('<script');
	});
});

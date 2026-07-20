import type { QrMatrix } from './encoder';

export interface RenderOptions {
	width: number;
	margin: number;
	darkColor: string;
	lightColor: string;
}

interface RgbColor {
	red: number;
	green: number;
	blue: number;
	hex: string;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

function parseColor(value: string, name: string): RgbColor {
	if (typeof value !== 'string' || !COLOR_PATTERN.test(value)) {
		throw new Error(`${name} must use the #RRGGBB format.`);
	}
	return {
		red: Number.parseInt(value.slice(1, 3), 16),
		green: Number.parseInt(value.slice(3, 5), 16),
		blue: Number.parseInt(value.slice(5, 7), 16),
		hex: value.toUpperCase(),
	};
}

function validateMatrix(matrix: QrMatrix): void {
	if (
		matrix === null ||
		typeof matrix !== 'object' ||
		!Number.isSafeInteger(matrix.size) ||
		matrix.size <= 0 ||
		!Array.isArray(matrix.modules) ||
		matrix.modules.length !== matrix.size
	) {
		throw new Error('QR matrix must be a non-empty square matrix.');
	}
	for (const row of matrix.modules) {
		if (
			!Array.isArray(row) ||
			row.length !== matrix.size ||
			row.some((module) => typeof module !== 'boolean')
		) {
			throw new Error('QR matrix must contain only boolean modules in a square grid.');
		}
	}
}

function validateRenderOptions(
	matrix: QrMatrix,
	options: RenderOptions,
): { totalModules: number; dark: RgbColor; light: RgbColor } {
	validateMatrix(matrix);
	if (!Number.isSafeInteger(options.width) || options.width < 64 || options.width > 4096) {
		throw new Error('QR width must be an integer between 64 and 4096 pixels.');
	}
	if (!Number.isSafeInteger(options.margin) || options.margin < 0 || options.margin > 64) {
		throw new Error('QR margin must be an integer between 0 and 64 modules.');
	}
	const totalModules = matrix.size + options.margin * 2;
	if (options.width < totalModules) {
		throw new Error(
			`QR width ${options.width}px is too small for ${totalModules} modules. Use at least ${totalModules}px so every module is rendered.`,
		);
	}
	return {
		totalModules,
		dark: parseColor(options.darkColor, 'Dark color'),
		light: parseColor(options.lightColor, 'Light color'),
	};
}

function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
	const typeBuffer = Buffer.from(type, 'ascii');
	const result = Buffer.allocUnsafe(data.length + 12);
	result.writeUInt32BE(data.length, 0);
	typeBuffer.copy(result, 4);
	data.copy(result, 8);
	result.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), data.length + 8);
	return result;
}
function adler32(data: Buffer): number {
	const modulus = 65_521;
	let first = 1;
	let second = 0;
	for (const byte of data) {
		first = (first + byte) % modulus;
		second = (second + first) % modulus;
	}
	return ((second << 16) | first) >>> 0;
}

function makeZlibStoredStream(data: Buffer): Buffer {
	const maximumBlockLength = 65_535;
	const blockCount = Math.ceil(data.length / maximumBlockLength);
	const output = Buffer.allocUnsafe(2 + data.length + blockCount * 5 + 4);
	let inputOffset = 0;
	let outputOffset = 0;

	output[outputOffset++] = 0x78;
	output[outputOffset++] = 0x01;
	while (inputOffset < data.length) {
		const length = Math.min(maximumBlockLength, data.length - inputOffset);
		const isFinal = inputOffset + length === data.length;
		output[outputOffset++] = isFinal ? 0x01 : 0x00;
		output.writeUInt16LE(length, outputOffset);
		outputOffset += 2;
		output.writeUInt16LE(0xffff ^ length, outputOffset);
		outputOffset += 2;
		data.copy(output, outputOffset, inputOffset, inputOffset + length);
		inputOffset += length;
		outputOffset += length;
	}
	output.writeUInt32BE(adler32(data), outputOffset);
	return output;
}

function isDarkPixel(
	matrix: QrMatrix,
	margin: number,
	scale: number,
	offset: number,
	x: number,
	y: number,
): boolean {
	const moduleX = Math.floor((x - offset) / scale) - margin;
	const moduleY = Math.floor((y - offset) / scale) - margin;
	return (
		moduleX >= 0 &&
		moduleY >= 0 &&
		moduleX < matrix.size &&
		moduleY < matrix.size &&
		matrix.modules[moduleY]![moduleX]!
	);
}

export function renderPng(matrix: QrMatrix, options: RenderOptions): Buffer {
	const { totalModules, dark, light } = validateRenderOptions(matrix, options);
	const scale = Math.floor(options.width / totalModules);
	const renderedSize = totalModules * scale;
	const offset = Math.floor((options.width - renderedSize) / 2);
	const rowBytes = Math.ceil(options.width / 8);
	const scanlines = Buffer.alloc((rowBytes + 1) * options.width, 0);

	for (let y = 0; y < options.width; y++) {
		const rowOffset = y * (rowBytes + 1) + 1; // The leading byte is PNG filter type 0.
		for (let x = 0; x < options.width; x++) {
			if (isDarkPixel(matrix, options.margin, scale, offset, x, y)) {
				scanlines[rowOffset + (x >>> 3)]! |= 1 << (7 - (x & 7));
			}
		}
	}

	const header = Buffer.alloc(13);
	header.writeUInt32BE(options.width, 0);
	header.writeUInt32BE(options.width, 4);
	header[8] = 1; // One bit per indexed pixel.
	header[9] = 3; // Indexed-color PNG.
	header[10] = 0;
	header[11] = 0;
	header[12] = 0;

	const palette = Buffer.from([
		light.red,
		light.green,
		light.blue,
		dark.red,
		dark.green,
		dark.blue,
	]);
	return Buffer.concat([
		PNG_SIGNATURE,
		makePngChunk('IHDR', header),
		makePngChunk('PLTE', palette),
		makePngChunk('IDAT', makeZlibStoredStream(scanlines)),
		makePngChunk('IEND', Buffer.alloc(0)),
	]);
}

export function renderSvg(matrix: QrMatrix, options: RenderOptions): string {
	const { totalModules, dark, light } = validateRenderOptions(matrix, options);
	const commands: string[] = [];
	for (let y = 0; y < matrix.size; y++) {
		let x = 0;
		while (x < matrix.size) {
			if (!matrix.modules[y]![x]) {
				x++;
				continue;
			}
			const start = x;
			while (x < matrix.size && matrix.modules[y]![x]) x++;
			const length = x - start;
			commands.push(`M${start + options.margin} ${y + options.margin}h${length}v1h-${length}z`);
		}
	}

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.width}" viewBox="0 0 ${totalModules} ${totalModules}" shape-rendering="crispEdges" role="img" aria-label="QR code">`,
		`<rect width="100%" height="100%" fill="${light.hex}"/>`,
		`<path fill="${dark.hex}" d="${commands.join('')}"/>`,
		'</svg>',
	].join('');
}

import {
	ECC_CODEWORDS_PER_BLOCK,
	NUM_ERROR_CORRECTION_BLOCKS,
	getNumRawDataModules,
	makeReedSolomonDivisor,
	makeReedSolomonRemainder,
	type ErrorCorrectionLevel,
	type QrMatrix,
} from './encoder';

export interface DecodedQr {
	content: string;
	version: number;
	errorCorrectionLevel: ErrorCorrectionLevel;
	mask: number;
}

interface GrayImage {
	width: number;
	height: number;
	pixels: Uint8Array;
}

interface Bounds {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

interface FormatInfo {
	level: ErrorCorrectionLevel;
	mask: number;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ALPHANUMERIC_CHARACTERS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const MAX_IMAGE_DIMENSION = 4096;
const MAX_IMAGE_PIXELS = 16_777_216;
export const MAX_PNG_INPUT_BYTES = 16 * 1024 * 1024;
export const MAX_PNG_COMPRESSED_BYTES = 8 * 1024 * 1024;

function paethPredictor(left: number, above: number, upperLeft: number): number {
	const prediction = left + above - upperLeft;
	const leftDistance = Math.abs(prediction - left);
	const aboveDistance = Math.abs(prediction - above);
	const upperLeftDistance = Math.abs(prediction - upperLeft);
	if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
	if (aboveDistance <= upperLeftDistance) return above;
	return upperLeft;
}

function readPackedSample(row: Uint8Array, index: number, bitDepth: number): number {
	if (bitDepth === 8) return row[index]!;
	const bitOffset = index * bitDepth;
	const byte = row[bitOffset >>> 3]!;
	const shift = 8 - bitDepth - (bitOffset & 7);
	return (byte >>> shift) & ((1 << bitDepth) - 1);
}

function blendWithWhite(luminance: number, alpha: number): number {
	return Math.round((luminance * alpha + 255 * (255 - alpha)) / 255);
}

function rgbToGray(red: number, green: number, blue: number): number {
	return Math.round((red * 299 + green * 587 + blue * 114) / 1000);
}

async function decodePng(buffer: Buffer): Promise<GrayImage> {
	if (buffer.length > MAX_PNG_INPUT_BYTES) {
		throw new Error('PNG input exceeds the 16 MiB limit.');
	}
	if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
		throw new Error('QR reader accepts PNG images only.');
	}

	let offset = 8;
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = -1;
	let interlace = 0;
	let palette: Buffer | undefined;
	let transparency: Buffer | undefined;
	const compressedParts: Buffer[] = [];
	let compressedLength = 0;

	while (offset + 12 <= buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const chunkEnd = offset + 12 + length;
		if (chunkEnd > buffer.length) throw new Error('PNG chunk exceeds the input length.');
		const type = buffer.toString('ascii', offset + 4, offset + 8);
		const data = buffer.subarray(offset + 8, offset + 8 + length);
		if (type === 'IHDR') {
			if (length !== 13) throw new Error('PNG header has an invalid length.');
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			bitDepth = data[8]!;
			colorType = data[9]!;
			if (data[10] !== 0 || data[11] !== 0) {
				throw new Error('PNG uses an unsupported compression or filter method.');
			}
			interlace = data[12]!;
		} else if (type === 'PLTE') {
			palette = Buffer.from(data);
		} else if (type === 'tRNS') {
			transparency = Buffer.from(data);
		} else if (type === 'IDAT') {
			if (length > MAX_PNG_COMPRESSED_BYTES - compressedLength) {
				throw new Error('PNG compressed image data exceeds the 8 MiB limit.');
			}
			compressedParts.push(data);
			compressedLength += length;
		} else if (type === 'IEND') {
			break;
		}
		offset = chunkEnd;
	}

	if (
		width <= 0 ||
		height <= 0 ||
		width > MAX_IMAGE_DIMENSION ||
		height > MAX_IMAGE_DIMENSION ||
		width * height > MAX_IMAGE_PIXELS
	) {
		throw new Error(
			'PNG dimensions must be between 1 and 4096 pixels with at most 16,777,216 pixels.',
		);
	}
	if (interlace !== 0) throw new Error('Interlaced PNG images are not supported.');
	if (compressedParts.length === 0) throw new Error('PNG contains no image data.');

	const channelsByColorType: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
	const channels = channelsByColorType[colorType];
	if (channels === undefined) throw new Error('PNG color type is not supported.');
	if (![1, 2, 4, 8].includes(bitDepth)) throw new Error('PNG bit depth is not supported.');
	if ((colorType === 2 || colorType === 4 || colorType === 6) && bitDepth !== 8) {
		throw new Error('True-color PNG input must use 8 bits per channel.');
	}
	if (colorType === 3 && (palette === undefined || palette.length % 3 !== 0)) {
		throw new Error('Indexed PNG input is missing a valid palette.');
	}

	const bitsPerPixel = channels * bitDepth;
	const rowLength = Math.ceil((width * bitsPerPixel) / 8);
	const filterBytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
	const expectedInflatedLength = (rowLength + 1) * height;
	const compressedBuffer = Buffer.concat(compressedParts, compressedLength);
	const compressed = new Uint8Array(
		compressedBuffer.buffer,
		compressedBuffer.byteOffset,
		compressedBuffer.byteLength,
	);
	const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate'));
	const reader = stream.getReader();
	const inflated = new Uint8Array(expectedInflatedLength);
	let inflatedOffset = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		if (inflatedOffset + chunk.value.length > expectedInflatedLength) {
			await reader.cancel();
			throw new Error('PNG decompressed data exceeds the expected length.');
		}
		inflated.set(chunk.value, inflatedOffset);
		inflatedOffset += chunk.value.length;
	}
	if (inflatedOffset !== expectedInflatedLength) {
		throw new Error('PNG decompressed data length is invalid.');
	}

	const rows: Uint8Array[] = [];
	for (let y = 0; y < height; y++) {
		const inputOffset = y * (rowLength + 1);
		const filter = inflated[inputOffset]!;
		const source = inflated.subarray(inputOffset + 1, inputOffset + 1 + rowLength);
		const row = new Uint8Array(rowLength);
		const previous = rows[y - 1];
		for (let index = 0; index < rowLength; index++) {
			const raw = source[index]!;
			const left = index >= filterBytesPerPixel ? row[index - filterBytesPerPixel]! : 0;
			const above = previous?.[index] ?? 0;
			const upperLeft =
				index >= filterBytesPerPixel ? (previous?.[index - filterBytesPerPixel] ?? 0) : 0;
			switch (filter) {
				case 0:
					row[index] = raw;
					break;
				case 1:
					row[index] = (raw + left) & 0xff;
					break;
				case 2:
					row[index] = (raw + above) & 0xff;
					break;
				case 3:
					row[index] = (raw + Math.floor((left + above) / 2)) & 0xff;
					break;
				case 4:
					row[index] = (raw + paethPredictor(left, above, upperLeft)) & 0xff;
					break;
				default:
					throw new Error('PNG uses an unsupported row filter.');
			}
		}
		rows.push(row);
	}

	const pixels = new Uint8Array(width * height);
	const sampleMaximum = (1 << bitDepth) - 1;
	for (let y = 0; y < height; y++) {
		const row = rows[y]!;
		for (let x = 0; x < width; x++) {
			let luminance: number;
			if (colorType === 0) {
				const sample = readPackedSample(row, x, bitDepth);
				luminance = Math.round((sample * 255) / sampleMaximum);
			} else if (colorType === 2) {
				const index = x * 3;
				luminance = rgbToGray(row[index]!, row[index + 1]!, row[index + 2]!);
			} else if (colorType === 3) {
				const paletteIndex = readPackedSample(row, x, bitDepth);
				const paletteOffset = paletteIndex * 3;
				if (paletteOffset + 2 >= palette!.length) throw new Error('PNG palette index is invalid.');
				luminance = rgbToGray(
					palette![paletteOffset]!,
					palette![paletteOffset + 1]!,
					palette![paletteOffset + 2]!,
				);
				luminance = blendWithWhite(luminance, transparency?.[paletteIndex] ?? 255);
			} else if (colorType === 4) {
				const index = x * 2;
				luminance = blendWithWhite(row[index]!, row[index + 1]!);
			} else {
				const index = x * 4;
				luminance = blendWithWhite(
					rgbToGray(row[index]!, row[index + 1]!, row[index + 2]!),
					row[index + 3]!,
				);
			}
			pixels[y * width + x] = luminance;
		}
	}
	return { width, height, pixels };
}

function chooseThreshold(pixels: Uint8Array): number {
	const histogram = new Array<number>(256).fill(0);
	let minimum = 255;
	let maximum = 0;
	for (const pixel of pixels) {
		histogram[pixel]!++;
		minimum = Math.min(minimum, pixel);
		maximum = Math.max(maximum, pixel);
	}
	if (maximum - minimum < 16)
		throw new Error('PNG does not contain enough contrast for a QR code.');

	let totalSum = 0;
	for (let value = 0; value < 256; value++) totalSum += value * histogram[value]!;
	let backgroundCount = 0;
	let backgroundSum = 0;
	let bestThreshold = Math.floor((minimum + maximum) / 2);
	let bestVariance = -1;
	for (let threshold = minimum; threshold < maximum; threshold++) {
		backgroundCount += histogram[threshold]!;
		if (backgroundCount === 0) continue;
		const foregroundCount = pixels.length - backgroundCount;
		if (foregroundCount === 0) break;
		backgroundSum += threshold * histogram[threshold]!;
		const backgroundMean = backgroundSum / backgroundCount;
		const foregroundMean = (totalSum - backgroundSum) / foregroundCount;
		const variance =
			backgroundCount *
			foregroundCount *
			(backgroundMean - foregroundMean) *
			(backgroundMean - foregroundMean);
		if (variance > bestVariance) {
			bestVariance = variance;
			bestThreshold = threshold;
		}
	}
	return bestThreshold;
}

function findBounds(image: GrayImage, threshold: number, inverted: boolean): Bounds | undefined {
	let left = image.width;
	let top = image.height;
	let right = -1;
	let bottom = -1;
	for (let y = 0; y < image.height; y++) {
		for (let x = 0; x < image.width; x++) {
			const belowThreshold = image.pixels[y * image.width + x]! <= threshold;
			const dark = inverted ? !belowThreshold : belowThreshold;
			if (!dark) continue;
			left = Math.min(left, x);
			top = Math.min(top, y);
			right = Math.max(right, x);
			bottom = Math.max(bottom, y);
		}
	}
	return right < left || bottom < top ? undefined : { left, top, right, bottom };
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

function finderMismatch(matrix: QrMatrix, centerX: number, centerY: number): number {
	let mismatch = 0;
	for (let deltaY = -3; deltaY <= 3; deltaY++) {
		for (let deltaX = -3; deltaX <= 3; deltaX++) {
			const distance = Math.max(Math.abs(deltaX), Math.abs(deltaY));
			const expected = distance !== 2;
			if (matrix.modules[centerY + deltaY]![centerX + deltaX] !== expected) mismatch++;
		}
	}
	return mismatch;
}

function structuralMismatch(matrix: QrMatrix): number {
	const lastCenter = matrix.size - 4;
	let mismatch =
		finderMismatch(matrix, 3, 3) +
		finderMismatch(matrix, lastCenter, 3) +
		finderMismatch(matrix, 3, lastCenter);
	for (let index = 8; index < matrix.size - 8; index++) {
		const expected = index % 2 === 0;
		if (matrix.modules[6]![index] !== expected) mismatch++;
		if (matrix.modules[index]![6] !== expected) mismatch++;
	}
	return mismatch;
}

function sampleMatrix(
	image: GrayImage,
	bounds: Bounds,
	threshold: number,
	inverted: boolean,
	size: number,
): QrMatrix {
	const boxWidth = bounds.right - bounds.left + 1;
	const boxHeight = bounds.bottom - bounds.top + 1;
	const modules = Array.from({ length: size }, () => new Array<boolean>(size));
	for (let y = 0; y < size; y++) {
		const sourceY = Math.min(
			bounds.bottom,
			Math.floor(bounds.top + ((y + 0.5) * boxHeight) / size),
		);
		for (let x = 0; x < size; x++) {
			const sourceX = Math.min(
				bounds.right,
				Math.floor(bounds.left + ((x + 0.5) * boxWidth) / size),
			);
			const belowThreshold = image.pixels[sourceY * image.width + sourceX]! <= threshold;
			modules[y]![x] = inverted ? !belowThreshold : belowThreshold;
		}
	}
	return { size, modules };
}

function formatCode(level: ErrorCorrectionLevel, mask: number): number {
	const levelBits: Readonly<Record<ErrorCorrectionLevel, number>> = { L: 1, M: 0, Q: 3, H: 2 };
	const data = (levelBits[level] << 3) | mask;
	let remainder = data;
	for (let index = 0; index < 10; index++) {
		remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
	}
	return ((data << 10) | remainder) ^ 0x5412;
}

function hammingDistance(left: number, right: number): number {
	let value = left ^ right;
	let count = 0;
	while (value !== 0) {
		count += value & 1;
		value >>>= 1;
	}
	return count;
}

function readFormatInfo(matrix: QrMatrix): FormatInfo {
	let bits = 0;
	const setBit = (index: number, value: boolean): void => {
		if (value) bits |= 1 << index;
	};
	for (let index = 0; index <= 5; index++) setBit(index, matrix.modules[index]![8]!);
	setBit(6, matrix.modules[7]![8]!);
	setBit(7, matrix.modules[8]![8]!);
	setBit(8, matrix.modules[8]![7]!);
	for (let index = 9; index < 15; index++) setBit(index, matrix.modules[8]![14 - index]!);

	let best: FormatInfo | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const level of ['L', 'M', 'Q', 'H'] as const) {
		for (let mask = 0; mask < 8; mask++) {
			const distance = hammingDistance(bits, formatCode(level, mask));
			if (distance < bestDistance) {
				bestDistance = distance;
				best = { level, mask };
			}
		}
	}
	if (best === undefined || bestDistance > 3) throw new Error('QR format information is invalid.');
	return best;
}

function alignmentPatternPositions(version: number, size: number): number[] {
	if (version === 1) return [];
	const count = Math.floor(version / 7) + 2;
	const step =
		version === 32 ? 26 : Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
	const result = [6];
	for (let position = size - 7; result.length < count; position -= step)
		result.splice(1, 0, position);
	return result;
}

function makeFunctionMask(version: number, size: number): boolean[][] {
	const mask = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
	const mark = (x: number, y: number): void => {
		if (x >= 0 && y >= 0 && x < size && y < size) mask[y]![x] = true;
	};
	for (let index = 0; index < size; index++) {
		mark(6, index);
		mark(index, 6);
	}
	for (const [centerX, centerY] of [
		[3, 3],
		[size - 4, 3],
		[3, size - 4],
	] as const) {
		for (let deltaY = -4; deltaY <= 4; deltaY++) {
			for (let deltaX = -4; deltaX <= 4; deltaX++) mark(centerX + deltaX, centerY + deltaY);
		}
	}
	const positions = alignmentPatternPositions(version, size);
	const last = positions.length - 1;
	for (let row = 0; row < positions.length; row++) {
		for (let column = 0; column < positions.length; column++) {
			if (
				(row === 0 && column === 0) ||
				(row === 0 && column === last) ||
				(row === last && column === 0)
			) {
				continue;
			}
			for (let deltaY = -2; deltaY <= 2; deltaY++) {
				for (let deltaX = -2; deltaX <= 2; deltaX++) {
					mark(positions[column]! + deltaX, positions[row]! + deltaY);
				}
			}
		}
	}
	for (let index = 0; index <= 5; index++) mark(8, index);
	mark(8, 7);
	mark(8, 8);
	mark(7, 8);
	for (let index = 9; index < 15; index++) mark(14 - index, 8);
	for (let index = 0; index < 8; index++) mark(size - 1 - index, 8);
	for (let index = 8; index < 15; index++) mark(8, size - 15 + index);
	mark(8, size - 8);
	if (version >= 7) {
		for (let index = 0; index < 18; index++) {
			const a = size - 11 + (index % 3);
			const b = Math.floor(index / 3);
			mark(a, b);
			mark(b, a);
		}
	}
	return mask;
}

function maskApplies(mask: number, x: number, y: number): boolean {
	switch (mask) {
		case 0:
			return (x + y) % 2 === 0;
		case 1:
			return y % 2 === 0;
		case 2:
			return x % 3 === 0;
		case 3:
			return (x + y) % 3 === 0;
		case 4:
			return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
		case 5:
			return ((x * y) % 2) + ((x * y) % 3) === 0;
		case 6:
			return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
		case 7:
			return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
		default:
			throw new Error('QR mask number is invalid.');
	}
}

function extractCodewords(matrix: QrMatrix, version: number, maskNumber: number): number[] {
	const functionMask = makeFunctionMask(version, matrix.size);
	const bitCount = Math.floor(getNumRawDataModules(version) / 8) * 8;
	const bits: number[] = [];
	for (let right = matrix.size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let vertical = 0; vertical < matrix.size; vertical++) {
			const y = ((right + 1) & 2) === 0 ? matrix.size - 1 - vertical : vertical;
			for (let column = 0; column < 2; column++) {
				const x = right - column;
				if (functionMask[y]![x] || bits.length >= bitCount) continue;
				const value = matrix.modules[y]![x] !== maskApplies(maskNumber, x, y);
				bits.push(value ? 1 : 0);
			}
		}
	}
	if (bits.length !== bitCount) throw new Error('QR data placement is incomplete.');
	const codewords: number[] = [];
	for (let offset = 0; offset < bits.length; offset += 8) {
		let value = 0;
		for (let bit = 0; bit < 8; bit++) value = (value << 1) | bits[offset + bit]!;
		codewords.push(value);
	}
	return codewords;
}

function deinterleaveData(
	codewords: readonly number[],
	version: number,
	level: ErrorCorrectionLevel,
): number[] {
	const blockCount = NUM_ERROR_CORRECTION_BLOCKS[level][version];
	const eccLength = ECC_CODEWORDS_PER_BLOCK[level][version];
	if (blockCount === undefined || eccLength === undefined) {
		throw new Error('QR error-correction table entry is missing.');
	}
	const rawCount = Math.floor(getNumRawDataModules(version) / 8);
	if (codewords.length !== rawCount) throw new Error('QR codeword count is invalid.');
	const shortBlockCount = blockCount - (rawCount % blockCount);
	const shortBlockLength = Math.floor(rawCount / blockCount);
	const dataLengths = Array.from(
		{ length: blockCount },
		(_, block) => shortBlockLength - eccLength + (block < shortBlockCount ? 0 : 1),
	);
	const dataBlocks = dataLengths.map((length) => new Array<number>(length));
	const eccBlocks = Array.from({ length: blockCount }, () => new Array<number>(eccLength));
	let offset = 0;
	const maximumDataLength = Math.max(...dataLengths);
	for (let index = 0; index < maximumDataLength; index++) {
		for (let block = 0; block < blockCount; block++) {
			if (index < dataLengths[block]!) dataBlocks[block]![index] = codewords[offset++]!;
		}
	}
	for (let index = 0; index < eccLength; index++) {
		for (let block = 0; block < blockCount; block++)
			eccBlocks[block]![index] = codewords[offset++]!;
	}
	if (offset !== codewords.length) throw new Error('QR interleaving layout is invalid.');

	const divisor = makeReedSolomonDivisor(eccLength);
	for (let block = 0; block < blockCount; block++) {
		const remainder = makeReedSolomonRemainder(dataBlocks[block]!, divisor);
		if (remainder.some((value, index) => value !== eccBlocks[block]![index])) {
			throw new Error('QR image contains damaged codewords that cannot be read safely.');
		}
	}
	return dataBlocks.flat();
}

class BitReader {
	private offset = 0;

	public constructor(private readonly bytes: readonly number[]) {}

	public get remaining(): number {
		return this.bytes.length * 8 - this.offset;
	}

	public read(length: number): number {
		if (length < 0 || length > 31 || length > this.remaining) {
			throw new Error('QR data stream ended unexpectedly.');
		}
		let value = 0;
		for (let index = 0; index < length; index++) {
			const bitOffset = this.offset++;
			value = (value << 1) | ((this.bytes[bitOffset >>> 3]! >>> (7 - (bitOffset & 7))) & 1);
		}
		return value;
	}
}

function countBits(version: number, small: number, medium: number, large: number): number {
	return version <= 9 ? small : version <= 26 ? medium : large;
}

function decodeBytes(bytes: number[], eciAssignment: number | undefined): string {
	const buffer = Buffer.from(bytes);
	if (eciAssignment === 3) return buffer.toString('latin1');
	if (eciAssignment !== undefined && eciAssignment !== 26) {
		throw new Error('QR uses an unsupported ECI character set.');
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
	} catch {
		return buffer.toString('latin1');
	}
}

function readEciAssignment(reader: BitReader): number {
	const first = reader.read(8);
	if ((first & 0x80) === 0) return first & 0x7f;
	if ((first & 0xc0) === 0x80) return ((first & 0x3f) << 8) | reader.read(8);
	if ((first & 0xe0) === 0xc0) return ((first & 0x1f) << 16) | reader.read(16);
	throw new Error('QR ECI assignment is invalid.');
}

function parsePayload(data: readonly number[], version: number): string {
	const reader = new BitReader(data);
	const parts: string[] = [];
	let eciAssignment: number | undefined;
	while (reader.remaining >= 4) {
		const mode = reader.read(4);
		if (mode === 0) break;
		if (mode === 7) {
			eciAssignment = readEciAssignment(reader);
			continue;
		}
		if (mode === 3) {
			reader.read(16);
			continue;
		}
		if (mode === 5 || mode === 9) continue;
		if (mode === 1) {
			let count = reader.read(countBits(version, 10, 12, 14));
			let value = '';
			while (count >= 3) {
				value += reader.read(10).toString().padStart(3, '0');
				count -= 3;
			}
			if (count === 2) value += reader.read(7).toString().padStart(2, '0');
			else if (count === 1) value += reader.read(4).toString();
			parts.push(value);
			continue;
		}
		if (mode === 2) {
			let count = reader.read(countBits(version, 9, 11, 13));
			let value = '';
			while (count >= 2) {
				const pair = reader.read(11);
				value += ALPHANUMERIC_CHARACTERS[Math.floor(pair / 45)] ?? '';
				value += ALPHANUMERIC_CHARACTERS[pair % 45] ?? '';
				count -= 2;
			}
			if (count === 1) value += ALPHANUMERIC_CHARACTERS[reader.read(6)] ?? '';
			parts.push(value);
			continue;
		}
		if (mode === 4) {
			const length = reader.read(countBits(version, 8, 16, 16));
			const bytes = Array.from({ length }, () => reader.read(8));
			parts.push(decodeBytes(bytes, eciAssignment));
			continue;
		}
		throw new Error('QR uses an unsupported data mode.');
	}
	if (parts.length === 0) throw new Error('QR contains no readable content.');
	return parts.join('');
}

function decodeMatrix(matrix: QrMatrix): DecodedQr {
	const version = (matrix.size - 17) / 4;
	if (!Number.isInteger(version) || version < 1 || version > 40) {
		throw new Error('QR matrix size does not map to a Model 2 version.');
	}
	const format = readFormatInfo(matrix);
	const codewords = extractCodewords(matrix, version, format.mask);
	const data = deinterleaveData(codewords, version, format.level);
	return {
		content: parsePayload(data, version),
		version,
		errorCorrectionLevel: format.level,
		mask: format.mask,
	};
}

export async function decodeQrPng(buffer: Buffer): Promise<DecodedQr> {
	if (!Buffer.isBuffer(buffer) || buffer.length === 0)
		throw new Error('PNG input must not be empty.');
	const image = await decodePng(buffer);
	const threshold = chooseThreshold(image.pixels);
	const candidates: Array<{ matrix: QrMatrix; mismatch: number }> = [];

	for (const inverted of [false, true]) {
		const bounds = findBounds(image, threshold, inverted);
		if (bounds === undefined) continue;
		const boxWidth = bounds.right - bounds.left + 1;
		const boxHeight = bounds.bottom - bounds.top + 1;
		if (Math.abs(boxWidth - boxHeight) > Math.max(2, Math.min(boxWidth, boxHeight) * 0.08))
			continue;
		for (let version = 1; version <= 40; version++) {
			const size = version * 4 + 17;
			if (boxWidth / size < 0.9 || boxHeight / size < 0.9) continue;
			let matrix = sampleMatrix(image, bounds, threshold, inverted, size);
			for (let rotation = 0; rotation < 4; rotation++) {
				const mismatch = structuralMismatch(matrix);
				if (mismatch <= 12) candidates.push({ matrix, mismatch });
				matrix = rotateClockwise(matrix);
			}
		}
	}
	candidates.sort((left, right) => left.mismatch - right.mismatch);
	let lastError: Error | undefined;
	for (const candidate of candidates) {
		try {
			return decodeMatrix(candidate.matrix);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error('Unknown QR decoding error.');
		}
	}
	if (lastError !== undefined) throw lastError;
	throw new Error('No axis-aligned QR code was found in the PNG image.');
}

export type ErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrMatrix {
	size: number;
	modules: boolean[][];
}

const MIN_VERSION = 1;
const MAX_VERSION = 40;

// Tables from ISO/IEC 18004. Index zero is deliberately unused so the
// remaining indices are QR version numbers.
export const ECC_CODEWORDS_PER_BLOCK: Readonly<Record<ErrorCorrectionLevel, readonly number[]>> = {
	L: [
		-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30,
		30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
	],
	M: [
		-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
		28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
	],
	Q: [
		-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30,
		30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
	],
	H: [
		-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30,
		30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
	],
};

export const NUM_ERROR_CORRECTION_BLOCKS: Readonly<
	Record<ErrorCorrectionLevel, readonly number[]>
> = {
	L: [
		-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14,
		15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
	],
	M: [
		-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23,
		25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
	],
	Q: [
		-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34,
		34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
	],
	H: [
		-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35,
		37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
	],
};

const FORMAT_BITS: Readonly<Record<ErrorCorrectionLevel, number>> = {
	L: 1,
	M: 0,
	Q: 3,
	H: 2,
};

class BitBuffer {
	public readonly bits: number[] = [];

	public append(value: number, length: number): void {
		if (length < 0 || length > 31 || value >>> length !== 0) {
			throw new Error('Internal QR bit-buffer error.');
		}
		for (let index = length - 1; index >= 0; index--) {
			this.bits.push((value >>> index) & 1);
		}
	}
}

export function getNumRawDataModules(version: number): number {
	let result = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const alignmentPatternCount = Math.floor(version / 7) + 2;
		result -= (25 * alignmentPatternCount - 10) * alignmentPatternCount - 55;
		if (version >= 7) result -= 36;
	}
	return result;
}

function getNumDataCodewords(version: number, level: ErrorCorrectionLevel): number {
	const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
	const eccCodewords = ECC_CODEWORDS_PER_BLOCK[level][version];
	const blockCount = NUM_ERROR_CORRECTION_BLOCKS[level][version];
	if (eccCodewords === undefined || blockCount === undefined) {
		throw new Error('Internal QR capacity table error.');
	}
	return rawCodewords - eccCodewords * blockCount;
}

function usesUtf8Eci(content: string): boolean {
	for (const character of content) {
		if (character.codePointAt(0)! > 0x7f) return true;
	}
	return false;
}

function getRequiredDataBits(byteLength: number, version: number, includeEci: boolean): number {
	const countBits = version <= 9 ? 8 : 16;
	if (byteLength >= 2 ** countBits) return Number.POSITIVE_INFINITY;
	return (includeEci ? 12 : 0) + 4 + countBits + byteLength * 8;
}

function chooseVersion(
	byteLength: number,
	level: ErrorCorrectionLevel,
	includeEci: boolean,
): number {
	for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
		if (
			getRequiredDataBits(byteLength, version, includeEci) <=
			getNumDataCodewords(version, level) * 8
		) {
			return version;
		}
	}
	throw new Error(
		`QR content is too large for error correction level ${level}. The maximum QR Model 2 version is 40.`,
	);
}

function makeDataCodewords(
	data: Buffer,
	version: number,
	level: ErrorCorrectionLevel,
	includeEci: boolean,
): number[] {
	const capacityBits = getNumDataCodewords(version, level) * 8;
	const buffer = new BitBuffer();

	if (includeEci) {
		buffer.append(0b0111, 4); // ECI mode
		buffer.append(26, 8); // UTF-8 assignment number
	}
	buffer.append(0b0100, 4); // Byte mode
	buffer.append(data.length, version <= 9 ? 8 : 16);
	for (const value of data) buffer.append(value, 8);

	buffer.append(0, Math.min(4, capacityBits - buffer.bits.length));
	while (buffer.bits.length % 8 !== 0) buffer.bits.push(0);

	const result: number[] = [];
	for (let index = 0; index < buffer.bits.length; index += 8) {
		let value = 0;
		for (let bit = 0; bit < 8; bit++) value = (value << 1) | buffer.bits[index + bit]!;
		result.push(value);
	}
	for (let pad = 0; result.length * 8 < capacityBits; pad++) {
		result.push(pad % 2 === 0 ? 0xec : 0x11);
	}
	return result;
}

function reedSolomonMultiply(left: number, right: number): number {
	let result = 0;
	for (let bit = 7; bit >= 0; bit--) {
		result = (result << 1) ^ ((result >>> 7) * 0x11d);
		result ^= ((right >>> bit) & 1) * left;
	}
	return result;
}

export function makeReedSolomonDivisor(degree: number): number[] {
	const result = new Array<number>(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let index = 0; index < degree; index++) {
		for (let coefficient = 0; coefficient < result.length; coefficient++) {
			result[coefficient] = reedSolomonMultiply(result[coefficient]!, root);
			if (coefficient + 1 < result.length) result[coefficient] ^= result[coefficient + 1]!;
		}
		root = reedSolomonMultiply(root, 0x02);
	}
	return result;
}

export function makeReedSolomonRemainder(
	data: readonly number[],
	divisor: readonly number[],
): number[] {
	const result = new Array<number>(divisor.length).fill(0);
	for (const value of data) {
		const factor = value ^ result[0]!;
		result.copyWithin(0, 1);
		result[result.length - 1] = 0;
		for (let index = 0; index < result.length; index++) {
			result[index] ^= reedSolomonMultiply(divisor[index]!, factor);
		}
	}
	return result;
}

function addErrorCorrectionAndInterleave(
	data: readonly number[],
	version: number,
	level: ErrorCorrectionLevel,
): number[] {
	const blockCount = NUM_ERROR_CORRECTION_BLOCKS[level][version]!;
	const blockEccLength = ECC_CODEWORDS_PER_BLOCK[level][version]!;
	const rawCodewordCount = Math.floor(getNumRawDataModules(version) / 8);
	const shortBlockCount = blockCount - (rawCodewordCount % blockCount);
	const shortBlockLength = Math.floor(rawCodewordCount / blockCount);
	const divisor = makeReedSolomonDivisor(blockEccLength);
	const dataBlocks: number[][] = [];
	const eccBlocks: number[][] = [];
	let offset = 0;

	for (let block = 0; block < blockCount; block++) {
		const dataLength = shortBlockLength - blockEccLength + (block < shortBlockCount ? 0 : 1);
		const blockData = data.slice(offset, offset + dataLength);
		offset += dataLength;
		dataBlocks.push(blockData);
		eccBlocks.push(makeReedSolomonRemainder(blockData, divisor));
	}
	if (offset !== data.length) throw new Error('Internal QR block partition error.');

	const result: number[] = [];
	const maxDataLength = Math.max(...dataBlocks.map((block) => block.length));
	for (let index = 0; index < maxDataLength; index++) {
		for (const block of dataBlocks) {
			if (index < block.length) result.push(block[index]!);
		}
	}
	for (let index = 0; index < blockEccLength; index++) {
		for (const block of eccBlocks) result.push(block[index]!);
	}
	if (result.length !== rawCodewordCount) throw new Error('Internal QR interleaving error.');
	return result;
}

class MatrixBuilder {
	private readonly modules: boolean[][];
	private readonly functionModules: boolean[][];

	public constructor(
		private readonly version: number,
		private readonly level: ErrorCorrectionLevel,
		private readonly codewords: readonly number[],
	) {
		const size = version * 4 + 17;
		this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
		this.functionModules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
	}

	private get size(): number {
		return this.modules.length;
	}

	public build(): QrMatrix {
		this.drawFunctionPatterns();
		this.drawCodewords();

		let bestMask = 0;
		let minimumPenalty = Number.POSITIVE_INFINITY;
		for (let mask = 0; mask < 8; mask++) {
			this.applyMask(mask);
			this.drawFormatBits(mask);
			const penalty = this.getPenaltyScore();
			if (penalty < minimumPenalty) {
				bestMask = mask;
				minimumPenalty = penalty;
			}
			this.applyMask(mask);
		}

		this.applyMask(bestMask);
		this.drawFormatBits(bestMask);
		return {
			size: this.size,
			modules: this.modules.map((row) => row.slice()),
		};
	}

	private setFunctionModule(x: number, y: number, dark: boolean): void {
		this.modules[y]![x] = dark;
		this.functionModules[y]![x] = true;
	}

	private drawFunctionPatterns(): void {
		for (let index = 0; index < this.size; index++) {
			this.setFunctionModule(6, index, index % 2 === 0);
			this.setFunctionModule(index, 6, index % 2 === 0);
		}
		this.drawFinderPattern(3, 3);
		this.drawFinderPattern(this.size - 4, 3);
		this.drawFinderPattern(3, this.size - 4);

		const alignments = this.getAlignmentPatternPositions();
		const last = alignments.length - 1;
		for (let row = 0; row < alignments.length; row++) {
			for (let column = 0; column < alignments.length; column++) {
				if (
					(row === 0 && column === 0) ||
					(row === 0 && column === last) ||
					(row === last && column === 0)
				) {
					continue;
				}
				this.drawAlignmentPattern(alignments[column]!, alignments[row]!);
			}
		}

		this.drawFormatBits(0);
		this.drawVersion();
	}

	private drawFinderPattern(centerX: number, centerY: number): void {
		for (let deltaY = -4; deltaY <= 4; deltaY++) {
			for (let deltaX = -4; deltaX <= 4; deltaX++) {
				const x = centerX + deltaX;
				const y = centerY + deltaY;
				if (x < 0 || x >= this.size || y < 0 || y >= this.size) continue;
				const distance = Math.max(Math.abs(deltaX), Math.abs(deltaY));
				this.setFunctionModule(x, y, distance !== 2 && distance !== 4);
			}
		}
	}

	private drawAlignmentPattern(centerX: number, centerY: number): void {
		for (let deltaY = -2; deltaY <= 2; deltaY++) {
			for (let deltaX = -2; deltaX <= 2; deltaX++) {
				this.setFunctionModule(
					centerX + deltaX,
					centerY + deltaY,
					Math.max(Math.abs(deltaX), Math.abs(deltaY)) !== 1,
				);
			}
		}
	}

	private getAlignmentPatternPositions(): number[] {
		if (this.version === 1) return [];
		const count = Math.floor(this.version / 7) + 2;
		const step =
			this.version === 32
				? 26
				: Math.floor((this.version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
		const result = [6];
		for (let position = this.size - 7; result.length < count; position -= step) {
			result.splice(1, 0, position);
		}
		return result;
	}

	private drawFormatBits(mask: number): void {
		const data = (FORMAT_BITS[this.level] << 3) | mask;
		let remainder = data;
		for (let index = 0; index < 10; index++) {
			remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
		}
		const bits = ((data << 10) | remainder) ^ 0x5412;
		const bit = (index: number): boolean => ((bits >>> index) & 1) !== 0;

		for (let index = 0; index <= 5; index++) this.setFunctionModule(8, index, bit(index));
		this.setFunctionModule(8, 7, bit(6));
		this.setFunctionModule(8, 8, bit(7));
		this.setFunctionModule(7, 8, bit(8));
		for (let index = 9; index < 15; index++) this.setFunctionModule(14 - index, 8, bit(index));

		for (let index = 0; index < 8; index++)
			this.setFunctionModule(this.size - 1 - index, 8, bit(index));
		for (let index = 8; index < 15; index++) {
			this.setFunctionModule(8, this.size - 15 + index, bit(index));
		}
		this.setFunctionModule(8, this.size - 8, true);
	}

	private drawVersion(): void {
		if (this.version < 7) return;
		let remainder = this.version;
		for (let index = 0; index < 12; index++) {
			remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
		}
		const bits = (this.version << 12) | remainder;
		for (let index = 0; index < 18; index++) {
			const dark = ((bits >>> index) & 1) !== 0;
			const a = this.size - 11 + (index % 3);
			const b = Math.floor(index / 3);
			this.setFunctionModule(a, b, dark);
			this.setFunctionModule(b, a, dark);
		}
	}

	private drawCodewords(): void {
		let bitIndex = 0;
		for (let right = this.size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			for (let vertical = 0; vertical < this.size; vertical++) {
				const y = ((right + 1) & 2) === 0 ? this.size - 1 - vertical : vertical;
				for (let column = 0; column < 2; column++) {
					const x = right - column;
					if (this.functionModules[y]![x] || bitIndex >= this.codewords.length * 8) continue;
					this.modules[y]![x] =
						((this.codewords[bitIndex >>> 3]! >>> (7 - (bitIndex & 7))) & 1) !== 0;
					bitIndex++;
				}
			}
		}
		if (bitIndex !== this.codewords.length * 8)
			throw new Error('Internal QR data placement error.');
	}

	private applyMask(mask: number): void {
		for (let y = 0; y < this.size; y++) {
			for (let x = 0; x < this.size; x++) {
				let invert: boolean;
				switch (mask) {
					case 0:
						invert = (x + y) % 2 === 0;
						break;
					case 1:
						invert = y % 2 === 0;
						break;
					case 2:
						invert = x % 3 === 0;
						break;
					case 3:
						invert = (x + y) % 3 === 0;
						break;
					case 4:
						invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
						break;
					case 5:
						invert = ((x * y) % 2) + ((x * y) % 3) === 0;
						break;
					case 6:
						invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
						break;
					case 7:
						invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
						break;
					default:
						throw new Error('Internal QR mask error.');
				}
				if (!this.functionModules[y]![x] && invert) this.modules[y]![x] = !this.modules[y]![x];
			}
		}
	}

	private getPenaltyScore(): number {
		let result = 0;
		for (const row of this.modules) result += this.getLinePenalty(row);
		for (let x = 0; x < this.size; x++) {
			result += this.getLinePenalty(this.modules.map((row) => row[x]!));
		}

		for (let y = 0; y < this.size - 1; y++) {
			for (let x = 0; x < this.size - 1; x++) {
				const color = this.modules[y]![x];
				if (
					color === this.modules[y]![x + 1] &&
					color === this.modules[y + 1]![x] &&
					color === this.modules[y + 1]![x + 1]
				) {
					result += 3;
				}
			}
		}

		const darkCount = this.modules.reduce(
			(total, row) => total + row.reduce((sum, module) => sum + (module ? 1 : 0), 0),
			0,
		);
		const total = this.size * this.size;
		const balanceSteps = Math.floor(Math.abs(darkCount * 20 - total * 10) / total);
		return result + balanceSteps * 10;
	}

	private getLinePenalty(line: readonly boolean[]): number {
		let result = 0;
		let runLength = 1;
		for (let index = 1; index < line.length; index++) {
			if (line[index] === line[index - 1]) {
				runLength++;
				if (runLength === 5) result += 3;
				else if (runLength > 5) result++;
			} else {
				runLength = 1;
			}
		}

		const finderPattern = [true, false, true, true, true, false, true] as const;
		for (let start = 0; start <= line.length - finderPattern.length; start++) {
			let matches = true;
			for (let index = 0; index < finderPattern.length; index++) {
				if (line[start + index] !== finderPattern[index]) {
					matches = false;
					break;
				}
			}
			if (!matches) continue;
			const beforeIsLight = [1, 2, 3, 4].every((distance) => !line[start - distance]);
			const afterIsLight = [0, 1, 2, 3].every(
				(offset) => !line[start + finderPattern.length + offset],
			);
			if (beforeIsLight) result += 40;
			if (afterIsLight) result += 40;
		}
		return result;
	}
}

export function generateQrMatrix(content: string, level: ErrorCorrectionLevel): QrMatrix {
	if (typeof content !== 'string') throw new Error('QR content must be a string.');
	if (content.length === 0) throw new Error('QR content must not be empty.');
	if (content.length > 10_000) throw new Error('QR content must not exceed 10,000 characters.');
	if (!(level in FORMAT_BITS)) throw new Error('QR error correction level must be L, M, Q, or H.');

	const data = Buffer.from(content, 'utf8');
	const includeEci = usesUtf8Eci(content);
	const version = chooseVersion(data.length, level, includeEci);
	const dataCodewords = makeDataCodewords(data, version, level, includeEci);
	const allCodewords = addErrorCorrectionAndInterleave(dataCodewords, version, level);
	return new MatrixBuilder(version, level, allCodewords).build();
}

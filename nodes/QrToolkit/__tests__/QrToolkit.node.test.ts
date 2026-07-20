/* eslint-disable @n8n/community-nodes/no-restricted-imports -- Test-only dependency, excluded from the published package. */

import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const qrMocks = vi.hoisted(() => ({
	decodeQrPng: vi.fn(),
	generateQrMatrix: vi.fn(),
	MAX_PNG_INPUT_BYTES: 16 * 1024 * 1024,
	renderPng: vi.fn(),
	renderSvg: vi.fn(),
}));

vi.mock('../qr', () => qrMocks);

import { QrToolkit, sanitizeFileName, validateOptions } from '../QrToolkit.node';
import { MAX_PNG_INPUT_BYTES } from '../qr/decoder';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEST_MATRIX = {
	size: 21,
	modules: Array.from({ length: 21 }, () => Array.from({ length: 21 }, () => false)),
};

type ParameterResolver = unknown | ((itemIndex: number) => unknown);

interface MockContextOptions {
	getBinaryDataBuffer?: (itemIndex: number, propertyName: string) => Promise<Buffer>;
	continueOnFail?: boolean;
	parameters?: Record<string, ParameterResolver>;
	prepareBinaryData?: (
		data: Buffer,
		fileName: string,
		mimeType: string,
	) => Promise<Record<string, unknown>>;
}

const DEFAULT_PARAMETERS: Record<string, ParameterResolver> = {
	operation: 'generateQrCode',
	content: 'https://example.com',
	outputFormat: 'png',
	width: 512,
	margin: 4,
	errorCorrectionLevel: 'M',
	darkColor: '#000000',
	lightColor: '#FFFFFF',
	binaryPropertyName: 'data',
	fileName: 'qr-code.png',
};

function createContext(
	items: INodeExecutionData[] = [{ json: {} }],
	options: MockContextOptions = {},
) {
	const parameters = { ...DEFAULT_PARAMETERS, ...options.parameters };
	const getBinaryDataBuffer = vi.fn(
		options.getBinaryDataBuffer ??
			(async () => {
				return PNG_SIGNATURE;
			}),
	);
	const prepareBinaryData = vi.fn(
		options.prepareBinaryData ??
			(async (data: Buffer, fileName: string, mimeType: string) => ({
				data: data.toString('base64'),
				mimeType,
				fileName,
				fileExtension: fileName.split('.').slice(-1)[0],
			})),
	);
	const context = {
		continueOnFail: vi.fn(() => options.continueOnFail ?? false),
		getInputData: vi.fn(() => items),
		getNode: vi.fn(() => ({
			id: 'test-node',
			name: 'QR Toolkit',
			type: '@cyberace/n8n-nodes-qr.qrToolkit',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		})),
		getNodeParameter: vi.fn((name: string, itemIndex: number, fallbackValue?: unknown) => {
			if (!Object.prototype.hasOwnProperty.call(parameters, name)) {
				return fallbackValue;
			}

			const parameter = parameters[name];
			return typeof parameter === 'function'
				? (parameter as (index: number) => unknown)(itemIndex)
				: parameter;
		}),
		helpers: {
			getBinaryDataBuffer,
			prepareBinaryData,
		},
	};

	return {
		context: context as unknown as IExecuteFunctions,
		getBinaryDataBuffer,
		getNodeParameter: context.getNodeParameter,
		prepareBinaryData,
	};
}

async function executeWith(context: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	return await QrToolkit.prototype.execute.call(context);
}

beforeEach(() => {
	vi.clearAllMocks();
	qrMocks.decodeQrPng.mockResolvedValue({
		content: 'decoded content',
		version: 4,
		errorCorrectionLevel: 'Q',
		mask: 6,
	});
	qrMocks.generateQrMatrix.mockReturnValue(TEST_MATRIX);
	qrMocks.renderPng.mockReturnValue(PNG_SIGNATURE);
	qrMocks.renderSvg.mockReturnValue(
		'<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><path d="M0 0"/></svg>',
	);
});

describe('QR Toolkit node description', () => {
	it('exposes the operation and documented defaults', () => {
		const description = new QrToolkit().description;
		const defaults = Object.fromEntries(
			description.properties
				.filter((property) => property.name !== 'fileName' || property.default === 'qr-code.png')
				.map((property) => [property.name, property.default]),
		);

		expect(description.displayName).toBe('QR Toolkit');
		expect(description.inputs).toEqual(['main']);
		expect(description.outputs).toEqual(['main']);
		expect(defaults).toMatchObject({
			operation: 'generateQrCode',
			outputFormat: 'png',
			width: 512,
			margin: 4,
			errorCorrectionLevel: 'M',
			darkColor: '#000000',
			lightColor: '#FFFFFF',
			binaryPropertyName: 'data',
			fileName: 'qr-code.png',
		});
	});
});

describe('QR Toolkit execution', () => {
	it('returns PNG binary data, metadata, and item linking without mutating the input', async () => {
		const input: INodeExecutionData[] = [
			{
				json: { id: 42, nested: { retained: true } },
				binary: {
					existing: {
						data: 'dGVzdA==',
						mimeType: 'text/plain',
						fileName: 'existing.txt',
					},
				},
			},
		];
		const original = structuredClone(input);
		const { context, prepareBinaryData } = createContext(input, {
			parameters: {
				binaryPropertyName: 'qrImage',
				fileName: '../exports/qr:unsafe.svg',
			},
		});

		const [[result]] = await executeWith(context);

		expect(input).toEqual(original);
		expect(qrMocks.generateQrMatrix).toHaveBeenCalledWith('https://example.com', 'M');
		expect(qrMocks.renderPng).toHaveBeenCalledWith(TEST_MATRIX, {
			width: 512,
			margin: 4,
			darkColor: '#000000',
			lightColor: '#FFFFFF',
		});
		expect(prepareBinaryData).toHaveBeenCalledWith(PNG_SIGNATURE, 'qr-unsafe.png', 'image/png');
		expect(result.binary?.existing).toEqual(input[0].binary?.existing);
		expect(result.binary?.qrImage).toMatchObject({
			mimeType: 'image/png',
			fileName: 'qr-unsafe.png',
		});
		expect(result.json).toMatchObject({
			id: 42,
			qrContent: 'https://example.com',
			qrFormat: 'png',
			qrWidth: 512,
			qrFileName: 'qr-unsafe.png',
		});
		expect(result.json.qrGeneratedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(result.pairedItem).toEqual({ item: 0 });
	});

	it('returns a UTF-8 SVG binary and never interpolates content into the SVG', async () => {
		const maliciousContent = '<script>alert("xss")</script><image href="https://attacker.invalid">';
		const { context, prepareBinaryData } = createContext([{ json: { keep: 'yes' } }], {
			parameters: {
				content: maliciousContent,
				outputFormat: 'svg',
				fileName: 'safe.png',
			},
		});

		const [[result]] = await executeWith(context);
		const [svgBuffer, fileName, mimeType] = prepareBinaryData.mock.calls[0];

		expect(qrMocks.generateQrMatrix).toHaveBeenCalledWith(maliciousContent, 'M');
		expect(qrMocks.renderSvg).toHaveBeenCalledOnce();
		expect(svgBuffer.toString('utf8')).toContain('<svg');
		expect(svgBuffer.toString('utf8')).not.toContain(maliciousContent);
		expect(fileName).toBe('safe.svg');
		expect(mimeType).toBe('image/svg+xml');
		expect(result.binary?.data).toMatchObject({
			fileExtension: 'svg',
			mimeType: 'image/svg+xml',
		});
		expect(result.json.keep).toBe('yes');
	});

	it('returns a PNG Base64 data URL in JSON without creating binary data', async () => {
		const { context, prepareBinaryData } = createContext([{ json: { source: 'input' } }], {
			parameters: { outputFormat: 'dataUrl' },
		});

		const [[result]] = await executeWith(context);

		expect(result.json).toEqual({
			source: 'input',
			dataUrl: `data:image/png;base64,${PNG_SIGNATURE.toString('base64')}`,
		});
		expect(result.binary).toBeUndefined();
		expect(result.pairedItem).toEqual({ item: 0 });
		expect(prepareBinaryData).not.toHaveBeenCalled();
		expect(qrMocks.renderSvg).not.toHaveBeenCalled();
	});

	it('reads a QR from binary data while preserving the input item', async () => {
		const input: INodeExecutionData[] = [
			{
				json: { id: 7 },
				binary: {
					photo: {
						data: PNG_SIGNATURE.toString('base64'),
						mimeType: 'image/png',
						fileName: 'input.png',
					},
				},
			},
		];
		const original = structuredClone(input);
		const { context, getBinaryDataBuffer } = createContext(input, {
			parameters: {
				operation: 'readQrCode',
				inputSource: 'binary',
				binaryPropertyName: 'photo',
			},
		});

		const [[result]] = await executeWith(context);

		expect(input).toEqual(original);
		expect(getBinaryDataBuffer).toHaveBeenCalledWith(0, 'photo');
		expect(qrMocks.decodeQrPng).toHaveBeenCalledWith(PNG_SIGNATURE);
		expect(result.json).toMatchObject({
			id: 7,
			qrContent: 'decoded content',
			qrVersion: 4,
			qrErrorCorrectionLevel: 'Q',
			qrMask: 6,
			qrReadFrom: 'photo',
		});
		expect(result.json.qrReadAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(result.binary).toEqual(input[0].binary);
		expect(result.pairedItem).toEqual({ item: 0 });
	});

	it('reads a QR from a PNG data URL without creating binary data', async () => {
		const dataUrl = 'data:image/png;base64,' + PNG_SIGNATURE.toString('base64');
		const { context, getBinaryDataBuffer } = createContext([{ json: { dataUrl } }], {
			parameters: {
				operation: 'readQrCode',
				inputSource: 'dataUrl',
				inputDataUrl: dataUrl,
			},
		});

		const [[result]] = await executeWith(context);

		expect(qrMocks.decodeQrPng).toHaveBeenCalledWith(PNG_SIGNATURE);
		expect(getBinaryDataBuffer).not.toHaveBeenCalled();
		expect(result.json).toMatchObject({
			dataUrl,
			qrContent: 'decoded content',
			qrReadFrom: 'dataUrl',
		});
		expect(result.binary).toBeUndefined();
	});

	it('accepts a binary PNG at the input-size limit', async () => {
		const image = Buffer.alloc(MAX_PNG_INPUT_BYTES);
		const { context } = createContext([{ json: {} }], {
			getBinaryDataBuffer: async () => image,
			parameters: {
				operation: 'readQrCode',
				inputSource: 'binary',
			},
		});

		await expect(executeWith(context)).resolves.toHaveLength(1);
		expect(qrMocks.decodeQrPng.mock.calls[0]?.[0]).toBe(image);
	});

	it('rejects an oversized binary PNG before invoking the decoder', async () => {
		const { context } = createContext([{ json: {} }], {
			getBinaryDataBuffer: async () => Buffer.alloc(MAX_PNG_INPUT_BYTES + 1),
			parameters: {
				operation: 'readQrCode',
				inputSource: 'binary',
			},
		});

		await expect(executeWith(context)).rejects.toThrow('PNG input exceeds the 16 MiB limit');
		expect(qrMocks.decodeQrPng).not.toHaveBeenCalled();
	});

	it('accepts a Base64 PNG at the input-size limit', async () => {
		const image = Buffer.alloc(MAX_PNG_INPUT_BYTES);
		const dataUrl = `data:image/png;base64,${image.toString('base64')}`;
		const { context } = createContext([{ json: {} }], {
			parameters: {
				operation: 'readQrCode',
				inputSource: 'dataUrl',
				inputDataUrl: dataUrl,
			},
		});

		await expect(executeWith(context)).resolves.toHaveLength(1);
		const decodedInput = qrMocks.decodeQrPng.mock.calls[0]?.[0] as Buffer;
		expect(decodedInput).toBeInstanceOf(Buffer);
		expect(decodedInput.length).toBe(MAX_PNG_INPUT_BYTES);
		expect(decodedInput.subarray(0, 8)).toEqual(image.subarray(0, 8));
	});

	it('rejects an oversized Base64 PNG before decoding it', async () => {
		const encoded = 'A'.repeat(Math.ceil((MAX_PNG_INPUT_BYTES + 1) / 3) * 4);
		const { context } = createContext([{ json: {} }], {
			parameters: {
				operation: 'readQrCode',
				inputSource: 'dataUrl',
				inputDataUrl: `data:image/png;base64,${encoded}`,
			},
		});

		await expect(executeWith(context)).rejects.toThrow('Data URL PNG exceeds the 16 MiB limit');
		expect(qrMocks.decodeQrPng).not.toHaveBeenCalled();
	});

	it('continues to the next item after rejecting an oversized binary PNG', async () => {
		const items: INodeExecutionData[] = [{ json: { id: 1 } }, { json: { id: 2 } }];
		const { context } = createContext(items, {
			continueOnFail: true,
			getBinaryDataBuffer: async (itemIndex) =>
				itemIndex === 0 ? Buffer.alloc(MAX_PNG_INPUT_BYTES + 1) : PNG_SIGNATURE,
			parameters: {
				operation: 'readQrCode',
				inputSource: 'binary',
			},
		});

		const [results] = await executeWith(context);

		expect(results[0]).toMatchObject({
			json: { id: 1 },
			pairedItem: { item: 0 },
			error: expect.any(NodeOperationError),
		});
		expect(results[1]?.json).toMatchObject({ id: 2, qrContent: 'decoded content' });
		expect(qrMocks.decodeQrPng).toHaveBeenCalledTimes(1);
	});

	it('rejects malformed read inputs and respects Continue On Fail', async () => {
		const { context } = createContext([{ json: { keep: true } }], {
			continueOnFail: true,
			parameters: {
				operation: 'readQrCode',
				inputSource: 'dataUrl',
				inputDataUrl: 'data:image/jpeg;base64,AAAA',
			},
		});

		const [[result]] = await executeWith(context);

		expect(result).toMatchObject({
			json: { keep: true },
			pairedItem: { item: 0 },
			error: expect.any(NodeOperationError),
		});
		expect(qrMocks.decodeQrPng).not.toHaveBeenCalled();
	});

	it('passes custom colors and each error correction level to the engine', async () => {
		for (const level of ['L', 'M', 'Q', 'H']) {
			const { context } = createContext([{ json: {} }], {
				parameters: {
					outputFormat: 'dataUrl',
					errorCorrectionLevel: level,
					darkColor: '#123aBC',
					lightColor: '#Fefefe',
				},
			});

			await executeWith(context);
		}

		expect(qrMocks.generateQrMatrix.mock.calls.map((call) => call[1])).toEqual([
			'L',
			'M',
			'Q',
			'H',
		]);
		expect(qrMocks.renderPng).toHaveBeenCalledWith(
			TEST_MATRIX,
			expect.objectContaining({ darkColor: '#123aBC', lightColor: '#Fefefe' }),
		);
	});

	it('resolves expressions per item and prepares binary data sequentially', async () => {
		const events: string[] = [];
		const items: INodeExecutionData[] = [
			{ json: { value: 'first' } },
			{ json: { value: 'second' } },
			{ json: { value: 'third' } },
		];
		const { context, getNodeParameter } = createContext(items, {
			parameters: {
				content: (itemIndex: number) => `content-${itemIndex}`,
				fileName: (itemIndex: number) => `qr-${itemIndex}.png`,
			},
			prepareBinaryData: async (_data, fileName, mimeType) => {
				events.push(`start:${fileName}`);
				await Promise.resolve();
				events.push(`end:${fileName}`);
				return { data: '', fileName, mimeType };
			},
		});

		const [results] = await executeWith(context);

		expect(results.map((item) => item.json.qrContent)).toEqual([
			'content-0',
			'content-1',
			'content-2',
		]);
		expect(results.map((item) => item.pairedItem)).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
		expect(events).toEqual([
			'start:qr-0.png',
			'end:qr-0.png',
			'start:qr-1.png',
			'end:qr-1.png',
			'start:qr-2.png',
			'end:qr-2.png',
		]);
		expect(getNodeParameter).toHaveBeenCalledWith('content', 2);
	});

	it('accepts the exact width limits', async () => {
		for (const width of [64, 4096]) {
			const { context } = createContext([{ json: {} }], {
				parameters: { outputFormat: 'dataUrl', width },
			});
			await expect(executeWith(context)).resolves.toHaveLength(1);
		}
	});

	it('rejects a width that cannot allocate one pixel per module including the margin', async () => {
		qrMocks.generateQrMatrix.mockReturnValue({ ...TEST_MATRIX, size: 57 });
		const { context } = createContext([{ json: {} }], {
			parameters: { outputFormat: 'dataUrl', width: 64, margin: 4 },
		});

		await expect(executeWith(context)).rejects.toThrow('Width must be at least 65 pixels');
	});

	it('propagates the engine capacity error with the failing item index', async () => {
		qrMocks.generateQrMatrix.mockImplementation(() => {
			throw new Error('Content exceeds QR capacity for error correction level H.');
		});
		const { context } = createContext([{ json: {} }], {
			parameters: { content: 'large payload', errorCorrectionLevel: 'H' },
		});

		try {
			await executeWith(context);
			expect.unreachable('Expected QR generation to fail');
		} catch (error) {
			expect(error).toBeInstanceOf(NodeOperationError);
			expect(error).toMatchObject({ context: expect.objectContaining({ itemIndex: 0 }) });
			expect((error as Error).message).toContain('Content exceeds QR capacity');
		}
	});

	it('continues after a per-item failure and preserves failed item data', async () => {
		qrMocks.generateQrMatrix.mockImplementation((content: string) => {
			if (content === 'bad') {
				throw new Error('Cannot encode bad content.');
			}

			return TEST_MATRIX;
		});
		const items: INodeExecutionData[] = [
			{
				json: { id: 1 },
				binary: { old: { data: 'eA==', mimeType: 'text/plain' } },
			},
			{ json: { id: 2 } },
		];
		const { context } = createContext(items, {
			continueOnFail: true,
			parameters: {
				content: (itemIndex: number) => (itemIndex === 0 ? 'bad' : 'good'),
				outputFormat: 'dataUrl',
			},
		});

		const [results] = await executeWith(context);

		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({
			json: { id: 1 },
			binary: items[0].binary,
			pairedItem: { item: 0 },
			error: expect.any(NodeOperationError),
		});
		expect(results[1].json).toMatchObject({
			id: 2,
			dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
		});
		expect(results[1].pairedItem).toEqual({ item: 1 });
	});
});

describe('validation', () => {
	const validOptions = {
		content: 'hello',
		outputFormat: 'png',
		width: 512,
		margin: 4,
		errorCorrectionLevel: 'M',
		darkColor: '#000000',
		lightColor: '#FFFFFF',
	};

	it.each([
		['empty content', { content: ' \n\t ' }, 'Content must not be empty'],
		['non-string content', { content: 123 }, 'Content must be a string'],
		['more than 10,000 characters', { content: '🙂'.repeat(10_001) }, 'no more than 10,000'],
		['unknown format', { outputFormat: 'pdf' }, 'Output Format must be'],
		['width below the limit', { width: 63 }, 'Width must be an integer'],
		['width above the limit', { width: 4097 }, 'Width must be an integer'],
		['fractional width', { width: 512.5 }, 'Width must be an integer'],
		['negative margin', { margin: -1 }, 'Margin must be an integer'],
		['margin above the limit', { margin: 65 }, 'Margin must be an integer'],
		['fractional margin', { margin: 2.5 }, 'Margin must be an integer'],
		['unknown error correction', { errorCorrectionLevel: 'X' }, 'Error Correction Level must be'],
		['short dark color', { darkColor: '#000' }, 'Dark Color must use the #RRGGBB format'],
		['invalid light color', { lightColor: 'white' }, 'Light Color must use the #RRGGBB format'],
	])('rejects %s', (_name, override, expectedMessage) => {
		expect(() => validateOptions({ ...validOptions, ...override })).toThrow(expectedMessage);
	});

	it('accepts zero and maximum margin values', () => {
		expect(validateOptions({ ...validOptions, margin: 0 }).margin).toBe(0);
		expect(validateOptions({ ...validOptions, margin: 64 }).margin).toBe(64);
	});

	it('rejects an empty binary property name during execution', async () => {
		const { context } = createContext([{ json: {} }], {
			parameters: { binaryPropertyName: '   ' },
		});

		await expect(executeWith(context)).rejects.toThrow('Binary Property Name must not be empty');
	});

	it('rejects an unknown operation saved in a malformed workflow', async () => {
		const { context } = createContext([{ json: {} }], {
			parameters: { operation: 'deleteEverything' },
		});

		await expect(executeWith(context)).rejects.toThrow('Operation must be Generate QR Code');
	});
});

describe('file name sanitization', () => {
	it.each([
		['../../private/qr-code.png', 'qr-code.png'],
		['..\\..\\private\\qr-code.svg', 'qr-code.png'],
		['invoice<>:"|?*.svg', 'invoice.svg'],
		['.png', 'qr-code.png'],
		['CON.png', '_CON.png'],
		['report.final', 'report.final.png'],
	])('sanitizes %s', (input, expected) => {
		expect(sanitizeFileName(input, expected.endsWith('.svg') ? 'svg' : 'png')).toBe(expected);
	});

	it('limits the complete file name to 128 Unicode characters', () => {
		const fileName = sanitizeFileName('🙂'.repeat(200), 'svg');

		expect(Array.from(fileName)).toHaveLength(128);
		expect(fileName.endsWith('.svg')).toBe(true);
	});
});

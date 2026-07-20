import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { ApplicationError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	decodeQrPng,
	generateQrMatrix,
	MAX_PNG_INPUT_BYTES,
	renderPng,
	renderSvg,
	type ErrorCorrectionLevel,
	type QrMatrix,
} from './qr';

const MAX_CONTENT_CHARACTERS = 10_000;
const MIN_WIDTH = 64;
const MAX_WIDTH = 4_096;
const MIN_MARGIN = 0;
const MAX_MARGIN = 64;
const MAX_FILE_NAME_CHARACTERS = 128;
const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
const MAX_PNG_BASE64_CHARACTERS = Math.ceil(MAX_PNG_INPUT_BYTES / 3) * 4;
const MAX_PNG_DATA_URL_CHARACTERS = PNG_DATA_URL_PREFIX.length + MAX_PNG_BASE64_CHARACTERS;

export type OutputFormat = 'png' | 'svg' | 'dataUrl';

export interface QrToolkitOptions {
	content: string;
	outputFormat: OutputFormat;
	width: number;
	margin: number;
	errorCorrectionLevel: ErrorCorrectionLevel;
	darkColor: string;
	lightColor: string;
}

function assertPngInputSize(byteLength: number): void {
	if (byteLength > MAX_PNG_INPUT_BYTES) {
		throw new ApplicationError('PNG input exceeds the 16 MiB limit.');
	}
}

function decodedBase64Length(value: string): number {
	const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
	return (value.length / 4) * 3 - padding;
}

function isStrictBase64(value: string): boolean {
	if (value.length === 0 || value.length % 4 !== 0) return false;
	let contentLength = value.length;
	if (value.endsWith('=')) contentLength--;
	if (value.endsWith('==')) contentLength--;
	if (contentLength === 0) return false;
	for (let index = 0; index < contentLength; index++) {
		const code = value.charCodeAt(index);
		const isDigit = code >= 48 && code <= 57;
		const isUppercase = code >= 65 && code <= 90;
		const isLowercase = code >= 97 && code <= 122;
		if (!isDigit && !isUppercase && !isLowercase && code !== 43 && code !== 47) return false;
	}
	for (let index = contentLength; index < value.length; index++) {
		if (value.charCodeAt(index) !== 61) return false;
	}
	return value.length - contentLength <= 2;
}

function decodePngDataUrl(value: string): Buffer {
	if (value.length > MAX_PNG_DATA_URL_CHARACTERS) {
		throw new ApplicationError('Data URL PNG exceeds the 16 MiB limit.');
	}
	const normalized = value.trim();
	if (normalized.length === 0) throw new ApplicationError('Data URL must not be empty.');
	const prefix = normalized.slice(0, PNG_DATA_URL_PREFIX.length);
	if (prefix.toLowerCase() !== PNG_DATA_URL_PREFIX) {
		throw new ApplicationError('Data URL must contain a Base64-encoded PNG image.');
	}
	const encoded = normalized.slice(PNG_DATA_URL_PREFIX.length);
	if (
		encoded.length > MAX_PNG_BASE64_CHARACTERS ||
		(encoded.length % 4 === 0 && decodedBase64Length(encoded) > MAX_PNG_INPUT_BYTES)
	) {
		throw new ApplicationError('Data URL PNG exceeds the 16 MiB limit.');
	}
	if (!isStrictBase64(encoded)) {
		throw new ApplicationError('Data URL must contain a Base64-encoded PNG image.');
	}
	const image = Buffer.from(encoded, 'base64');
	if (image.length === 0) throw new ApplicationError('Data URL PNG must not be empty.');
	return image;
}

interface RawQrToolkitOptions {
	content: unknown;
	outputFormat: unknown;
	width: unknown;
	margin: unknown;
	errorCorrectionLevel: unknown;
	darkColor: unknown;
	lightColor: unknown;
}

function assertIntegerInRange(
	value: unknown,
	minimum: number,
	maximum: number,
	message: string,
): asserts value is number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
		throw new ApplicationError(message);
	}
}

function assertHexColor(value: unknown, fieldName: string): asserts value is string {
	if (typeof value !== 'string' || !HEX_COLOR_PATTERN.test(value)) {
		throw new ApplicationError(`${fieldName} must use the #RRGGBB format.`);
	}
}

export function validateOptions(options: RawQrToolkitOptions): QrToolkitOptions {
	if (typeof options.content !== 'string') {
		throw new ApplicationError('Content must be a string.');
	}

	if (options.content.trim().length === 0) {
		throw new ApplicationError('Content must not be empty.');
	}

	if (Array.from(options.content).length > MAX_CONTENT_CHARACTERS) {
		throw new ApplicationError('Content must contain no more than 10,000 characters.');
	}

	if (!['png', 'svg', 'dataUrl'].includes(options.outputFormat as string)) {
		throw new ApplicationError('Output Format must be PNG, SVG, or Base64 Data URL.');
	}

	assertIntegerInRange(
		options.width,
		MIN_WIDTH,
		MAX_WIDTH,
		'Width must be an integer between 64 and 4096 pixels.',
	);
	assertIntegerInRange(
		options.margin,
		MIN_MARGIN,
		MAX_MARGIN,
		'Margin must be an integer between 0 and 64 modules.',
	);

	if (!['L', 'M', 'Q', 'H'].includes(options.errorCorrectionLevel as string)) {
		throw new ApplicationError('Error Correction Level must be L, M, Q, or H.');
	}

	assertHexColor(options.darkColor, 'Dark Color');
	assertHexColor(options.lightColor, 'Light Color');

	return {
		content: options.content,
		outputFormat: options.outputFormat as OutputFormat,
		width: options.width,
		margin: options.margin,
		errorCorrectionLevel: options.errorCorrectionLevel as ErrorCorrectionLevel,
		darkColor: options.darkColor,
		lightColor: options.lightColor,
	};
}

function truncateToCharacters(value: string, maximum: number): string {
	return Array.from(value).slice(0, maximum).join('');
}

function replaceUnsafeFileNameCharacters(value: string): string {
	let result = '';
	for (const character of value) {
		const code = character.charCodeAt(0);
		const isControlCharacter = code <= 0x1f || code === 0x7f;
		const isReservedCharacter = '<>:"/\\|?*'.includes(character);
		result += isControlCharacter || isReservedCharacter ? '-' : character;
	}
	return result;
}

export function sanitizeFileName(value: unknown, extension: 'png' | 'svg'): string {
	const rawName = typeof value === 'string' ? value : '';
	const pathSegments = rawName.split(/[\\/]/);
	const lastPathSegment = pathSegments[pathSegments.length - 1] ?? '';
	let baseName = lastPathSegment.trim().replace(/\.(?:png|svg)$/i, '');

	baseName = replaceUnsafeFileNameCharacters(baseName)
		.replace(/-+/g, '-')
		.replace(/^\.+/, '')
		.replace(/[ .-]+$/g, '')
		.trim();

	if (baseName.length === 0) {
		baseName = 'qr-code';
	}

	if (WINDOWS_RESERVED_NAME_PATTERN.test(baseName)) {
		baseName = `_${baseName}`;
	}

	const suffix = `.${extension}`;
	const maximumBaseLength = MAX_FILE_NAME_CHARACTERS - suffix.length;
	baseName = truncateToCharacters(baseName, maximumBaseLength).replace(/[ .-]+$/g, '');

	if (baseName.length === 0) {
		baseName = 'qr-code';
	}

	return `${baseName}${suffix}`;
}

function assertRenderableWidth(matrix: QrMatrix, width: number, margin: number): void {
	const minimumWidth = matrix.size + margin * 2;

	if (width < minimumWidth) {
		throw new ApplicationError(
			`Width must be at least ${minimumWidth} pixels for this QR code and margin so every module has at least one pixel.`,
		);
	}
}

function cloneInputItem(item: INodeExecutionData): INodeExecutionData {
	return {
		json: { ...item.json },
		...(item.binary === undefined ? {} : { binary: { ...item.binary } }),
	};
}

function toError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}

	return new ApplicationError(
		typeof error === 'string' ? error : 'An unknown QR Toolkit error occurred.',
	);
}

export class QrToolkit implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'QR Toolkit',
		name: 'qrToolkit',
		subtitle: '={{$parameter["operation"]}}',
		icon: { light: 'file:qrToolkit.svg', dark: 'file:qrToolkit.dark.svg' },
		group: ['transform'],
		version: 1,
		description: 'Generate and read QR codes locally without external services',
		defaults: {
			name: 'QR Toolkit',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Generate QR Code',
						value: 'generateQrCode',
						description: 'Generate a QR code from text or a URL',
						action: 'Generate a QR code',
					},
					{
						name: 'Read QR Code',
						value: 'readQrCode',
						description: 'Read content from an axis-aligned PNG QR code',
						action: 'Read a QR code',
					},
				],
				default: 'generateQrCode',
			},
			{
				displayName: 'Content',
				name: 'content',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				default: '',
				required: true,
				placeholder: 'https://example.com',
				displayOptions: {
					show: {
						operation: ['generateQrCode'],
					},
				},
				description: 'Text or URL to encode in the QR code',
			},
			{
				displayName: 'Output Format',
				name: 'outputFormat',
				type: 'options',
				options: [
					{
						name: 'Base64 Data URL',
						value: 'dataUrl',
						description: 'Return a PNG image as a Base64 data URL in JSON',
					},
					{
						name: 'PNG',
						value: 'png',
						description: 'Return a PNG image in a binary property',
					},
					{
						name: 'SVG',
						value: 'svg',
						description: 'Return an SVG image in a binary property',
					},
				],
				default: 'png',
				displayOptions: {
					show: {
						operation: ['generateQrCode'],
					},
				},
				description: 'How to return the generated QR code',
			},
			{
				displayName: 'Width',
				name: 'width',
				type: 'number',
				typeOptions: {
					minValue: MIN_WIDTH,
					maxValue: MAX_WIDTH,
					numberPrecision: 0,
				},
				default: 512,
				displayOptions: {
					show: {
						operation: ['generateQrCode'],
					},
				},
				description: 'Output image width in pixels',
			},
			{
				displayName: 'Margin',
				name: 'margin',
				type: 'number',
				typeOptions: {
					minValue: MIN_MARGIN,
					maxValue: MAX_MARGIN,
					numberPrecision: 0,
				},
				default: 4,
				displayOptions: {
					show: {
						operation: ['generateQrCode'],
					},
				},
				description: 'Quiet-zone width in QR modules',
			},
			{
				displayName: 'Error Correction Level',
				name: 'errorCorrectionLevel',
				type: 'options',
				options: [
					{
						name: 'High (H)',
						value: 'H',
						description: 'Recover approximately 30% of damaged codewords',
					},
					{
						name: 'Low (L)',
						value: 'L',
						description: 'Recover approximately 7% of damaged codewords',
					},
					{
						name: 'Medium (M)',
						value: 'M',
						description: 'Recover approximately 15% of damaged codewords',
					},
					{
						name: 'Quartile (Q)',
						value: 'Q',
						description: 'Recover approximately 25% of damaged codewords',
					},
				],
				default: 'M',
				displayOptions: {
					show: {
						operation: ['generateQrCode'],
					},
				},
				description: 'Amount of damage the QR code can recover from',
			},
			{
				displayName: 'Dark Color',
				name: 'darkColor',
				type: 'color',
				default: '#000000',
				displayOptions: {
					show: {
						operation: ['generateQrCode'],
					},
				},
				description: 'Color used for dark QR modules in #RRGGBB format',
			},
			{
				displayName: 'Light Color',
				name: 'lightColor',
				type: 'color',
				default: '#FFFFFF',
				displayOptions: {
					show: {
						operation: ['generateQrCode'],
					},
				},
				description: 'Color used for the QR background in #RRGGBB format',
			},
			{
				displayName: 'Binary Property Name',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: {
					show: {
						operation: ['generateQrCode'],
						outputFormat: ['png', 'svg'],
					},
				},
				description: 'Name of the binary property that receives the image',
			},
			{
				displayName: 'File Name',
				name: 'fileName',
				type: 'string',
				default: 'qr-code.png',
				displayOptions: {
					show: {
						operation: ['generateQrCode'],
						outputFormat: ['png'],
					},
				},
				description: 'File name for the generated PNG image',
			},
			{
				displayName: 'File Name',
				name: 'fileName',
				type: 'string',
				default: 'qr-code.svg',
				displayOptions: {
					show: {
						operation: ['generateQrCode'],
						outputFormat: ['svg'],
					},
				},
				description: 'File name for the generated SVG image',
			},
			{
				displayName: 'Input Source',
				name: 'inputSource',
				type: 'options',
				options: [
					{
						name: 'Base64 Data URL',
						value: 'dataUrl',
						description: 'Read a PNG data URL from a parameter or expression',
					},
					{
						name: 'Binary Property',
						value: 'binary',
						description: 'Read a PNG from an incoming binary property',
					},
				],
				default: 'binary',
				displayOptions: {
					show: {
						operation: ['readQrCode'],
					},
				},
				description: 'Where to read the PNG QR image from',
			},
			{
				displayName: 'Binary Property Name',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: {
					show: {
						operation: ['readQrCode'],
						inputSource: ['binary'],
					},
				},
				description: 'Name of the incoming binary property containing the PNG image',
			},
			{
				displayName: 'Data URL',
				name: 'inputDataUrl',
				type: 'string',
				typeOptions: {
					rows: 3,
				},
				default: '={{ $json.dataUrl }}',
				required: true,
				displayOptions: {
					show: {
						operation: ['readQrCode'],
						inputSource: ['dataUrl'],
					},
				},
				description: 'PNG data URL to decode',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const inputItems = this.getInputData();
		const outputItems: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < inputItems.length; itemIndex++) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex, 'generateQrCode');

				if (operation === 'readQrCode') {
					const inputSource = this.getNodeParameter('inputSource', itemIndex, 'binary');
					let image: Buffer;
					let sourceDescription: string;

					if (inputSource === 'binary') {
						const propertyValue = this.getNodeParameter('binaryPropertyName', itemIndex, 'data');
						if (typeof propertyValue !== 'string' || propertyValue.trim().length === 0) {
							throw new ApplicationError('Binary Property Name must not be empty.');
						}
						const propertyName = propertyValue.trim();
						image = await this.helpers.getBinaryDataBuffer(itemIndex, propertyName);
						assertPngInputSize(image.length);
						sourceDescription = propertyName;
					} else if (inputSource === 'dataUrl') {
						const dataUrlValue = this.getNodeParameter('inputDataUrl', itemIndex);
						if (typeof dataUrlValue !== 'string') {
							throw new ApplicationError('Data URL must not be empty.');
						}
						image = decodePngDataUrl(dataUrlValue);
						sourceDescription = 'dataUrl';
					} else {
						throw new ApplicationError('Input Source must be Binary Property or Base64 Data URL.');
					}

					const decoded = await decodeQrPng(image);
					const outputItem = cloneInputItem(inputItems[itemIndex]);
					outputItem.pairedItem = { item: itemIndex };
					outputItem.json.qrContent = decoded.content;
					outputItem.json.qrVersion = decoded.version;
					outputItem.json.qrErrorCorrectionLevel = decoded.errorCorrectionLevel;
					outputItem.json.qrMask = decoded.mask;
					outputItem.json.qrReadFrom = sourceDescription;
					outputItem.json.qrReadAt = new Date().toISOString();
					outputItems.push(outputItem);
					continue;
				}

				if (operation !== 'generateQrCode') {
					throw new ApplicationError('Operation must be Generate QR Code or Read QR Code.');
				}

				const options = validateOptions({
					content: this.getNodeParameter('content', itemIndex),
					outputFormat: this.getNodeParameter('outputFormat', itemIndex, 'png'),
					width: this.getNodeParameter('width', itemIndex, 512),
					margin: this.getNodeParameter('margin', itemIndex, 4),
					errorCorrectionLevel: this.getNodeParameter('errorCorrectionLevel', itemIndex, 'M'),
					darkColor: this.getNodeParameter('darkColor', itemIndex, '#000000'),
					lightColor: this.getNodeParameter('lightColor', itemIndex, '#FFFFFF'),
				});

				const matrix = generateQrMatrix(options.content, options.errorCorrectionLevel);
				assertRenderableWidth(matrix, options.width, options.margin);

				const renderOptions = {
					width: options.width,
					margin: options.margin,
					darkColor: options.darkColor,
					lightColor: options.lightColor,
				};
				const outputItem = cloneInputItem(inputItems[itemIndex]);
				outputItem.pairedItem = { item: itemIndex };

				if (options.outputFormat === 'dataUrl') {
					const png = renderPng(matrix, renderOptions);
					outputItem.json.dataUrl = 'data:image/png;base64,' + png.toString('base64');
					outputItems.push(outputItem);
					continue;
				}

				const binaryPropertyValue = this.getNodeParameter('binaryPropertyName', itemIndex, 'data');
				if (typeof binaryPropertyValue !== 'string' || binaryPropertyValue.trim().length === 0) {
					throw new ApplicationError('Binary Property Name must not be empty.');
				}
				const binaryPropertyName = binaryPropertyValue.trim();
				const extension = options.outputFormat;
				const fileName = sanitizeFileName(
					this.getNodeParameter('fileName', itemIndex, 'qr-code.' + extension),
					extension,
				);
				const mimeType = options.outputFormat === 'png' ? 'image/png' : 'image/svg+xml';
				const image =
					options.outputFormat === 'png'
						? renderPng(matrix, renderOptions)
						: Buffer.from(renderSvg(matrix, renderOptions), 'utf8');
				const binaryData = await this.helpers.prepareBinaryData(image, fileName, mimeType);

				outputItem.binary = {
					...(outputItem.binary ?? {}),
					[binaryPropertyName]: binaryData,
				};
				outputItem.json.qrContent = options.content;
				outputItem.json.qrFormat = options.outputFormat;
				outputItem.json.qrWidth = options.width;
				outputItem.json.qrFileName = fileName;
				outputItem.json.qrGeneratedAt = new Date().toISOString();
				outputItems.push(outputItem);
			} catch (error) {
				const nodeError = new NodeOperationError(this.getNode(), toError(error), { itemIndex });

				if (!this.continueOnFail()) {
					throw nodeError;
				}

				const failedItem = cloneInputItem(inputItems[itemIndex]);
				failedItem.error = nodeError;
				failedItem.pairedItem = { item: itemIndex };
				outputItems.push(failedItem);
			}
		}

		return [outputItems];
	}
}

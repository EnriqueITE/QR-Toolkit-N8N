import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { ApplicationError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	generateQrMatrix,
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
		typeof error === 'string' ? error : 'An unknown QR generation error occurred.',
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
		description: 'Generate QR codes locally as PNG, SVG, or Base64 data URLs',
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
				description: 'Amount of damage the QR code can recover from',
			},
			{
				displayName: 'Dark Color',
				name: 'darkColor',
				type: 'color',
				default: '#000000',
				description: 'Color used for dark QR modules in #RRGGBB format',
			},
			{
				displayName: 'Light Color',
				name: 'lightColor',
				type: 'color',
				default: '#FFFFFF',
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
						outputFormat: ['svg'],
					},
				},
				description: 'File name for the generated SVG image',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const inputItems = this.getInputData();
		const outputItems: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < inputItems.length; itemIndex++) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex, 'generateQrCode');

				if (operation !== 'generateQrCode') {
					throw new ApplicationError('Operation must be Generate QR Code.');
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
					outputItem.json.dataUrl = `data:image/png;base64,${png.toString('base64')}`;
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
					this.getNodeParameter('fileName', itemIndex, `qr-code.${extension}`),
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

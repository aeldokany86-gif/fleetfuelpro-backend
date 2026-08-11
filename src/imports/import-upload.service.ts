import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import {
  ImportBatchStatus,
  ImportExecutionMode,
  ImportType,
  Prisma,
} from '@prisma/client';
import { createHash } from 'crypto';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { ImportsService } from './imports.service';

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const PROJECTS_TEMPLATE_TYPE = 'PROJECTS';
const PROJECTS_SCHEMA_VERSION = 1;
const PROJECTS_MAX_ROWS = 500;
const PROJECTS_EXECUTION_MODE = 'ALL_OR_NOTHING';
const EMPLOYEES_TEMPLATE_TYPE = 'EMPLOYEES';
const EMPLOYEES_SCHEMA_VERSION = 1;
const EMPLOYEES_MAX_ROWS = 500;
const EMPLOYEES_EXECUTION_MODE = 'ALL_OR_NOTHING';
const STATIONS_TEMPLATE_TYPE = 'STATIONS';
const STATIONS_SCHEMA_VERSION = 1;
const STATIONS_MAX_ROWS = 500;
const STATIONS_EXECUTION_MODE = 'ALL_OR_NOTHING';

const PROJECTS_CANONICAL_FIELDS = [
  'projectCode',
  'projectName',
  'location',
  'description',
  'status',
  'projectStartDate',
  'basePricePerLiter',
  'transportCostPerLiter',
  'vatRate',
] as const;

const STATIONS_CANONICAL_FIELDS = [
  'stationId',
  'stationName',
  'stationType',
  'capacity',
  'projectCode',
  'openingBalance',
  'currentCounter',
] as const;

const EMPLOYEES_CANONICAL_FIELDS = [
  'employeeId',
  'employeeName',
  'phone',
  'email',
  'projectCode',
  'jobTitle',
] as const;

type UploadProjectsTemplateInput = {
  file?: Express.Multer.File;
  actorUserId: string;
  actorRoleName: string;
  actorCompanyId: string;
  targetCompanyId?: string;
};

type UploadEmployeesTemplateInput = UploadProjectsTemplateInput;
type UploadStationsTemplateInput = UploadProjectsTemplateInput;

type MetaMapping = {
  columnHeader: string;
  canonicalField: string;
  required: string;
  type: string;
  rules: string;
};

type ParsedImportRow = {
  rowNumber: number;
  sourceData: Record<string, Prisma.InputJsonValue>;
};

@Injectable()
export class ImportUploadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly importsService: ImportsService,
  ) {}

  async uploadProjectsTemplate(input: UploadProjectsTemplateInput) {
    const context = await this.importsService.resolveImportContext(
      input.actorUserId,
      input.actorRoleName,
      input.actorCompanyId,
      input.targetCompanyId,
    );

    const file = input.file;

    if (!file) {
      this.fail('FILE_REQUIRED', 'Excel file is required');
    }

    this.validateFileBasics(file);

    const fileHash = createHash('sha256')
      .update(file.buffer)
      .digest('hex');

    const workbook = new ExcelJS.Workbook();

    try {
      await workbook.xlsx.load(file.buffer as any);
    } catch {
      this.fail(
        'INVALID_FILE_TYPE',
        'The uploaded file is not a valid .xlsx workbook',
      );
    }

    const metadata = this.readProjectsMetadata(workbook);
    const parsedRows = this.readProjectsRows(workbook, metadata);

    const createdBatch = await this.prisma.importBatch.create({
      data: {
        companyId: context.companyId,
        importType: ImportType.PROJECTS,
        schemaVersion: metadata.schemaVersion,
        validationVersion: 1,
        templateLanguage: metadata.templateLanguage,
        originalFileName: file.originalname,
        fileSizeBytes: file.size,
        fileHash,
        status: ImportBatchStatus.UPLOADED,
        executionMode: ImportExecutionMode.ALL_OR_NOTHING,
        totalRows: parsedRows.length,
        uploadedByUserId: context.actor.id,
        rows:
          parsedRows.length > 0
            ? {
                create: parsedRows.map((row) => ({
                  rowNumber: row.rowNumber,
                  sourceData: row.sourceData,
                  isValid: false,
                })),
              }
            : undefined,
      },
    });

    const batch = await this.prisma.importBatch.findUniqueOrThrow({
      where: { id: createdBatch.id },
      include: {
        company: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        uploadedBy: {
          select: {
            id: true,
            fullName: true,
            username: true,
          },
        },
      },
    });

    return {
      batch,
      parsedRows: {
        totalRows: parsedRows.length,
        firstRowNumber:
          parsedRows.length > 0 ? parsedRows[0].rowNumber : null,
        lastRowNumber:
          parsedRows.length > 0
            ? parsedRows[parsedRows.length - 1].rowNumber
            : null,
      },
      metadata: {
        templateType: metadata.templateType,
        schemaVersion: metadata.schemaVersion,
        templateLanguage: metadata.templateLanguage,
        dataSheet: metadata.dataSheet,
        maxRows: metadata.maxRows,
        executionMode: metadata.executionMode,
        mappings: metadata.mappings,
      },
    };
  }


  async uploadEmployeesTemplate(input: UploadEmployeesTemplateInput) {
    const context = await this.importsService.resolveImportContext(
      input.actorUserId,
      input.actorRoleName,
      input.actorCompanyId,
      input.targetCompanyId,
    );

    const file = input.file;
    if (!file) {
      this.fail('FILE_REQUIRED', 'Excel file is required');
    }

    this.validateFileBasics(file);

    const fileHash = createHash('sha256')
      .update(file.buffer)
      .digest('hex');

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(file.buffer as any);
    } catch {
      this.fail(
        'INVALID_FILE_TYPE',
        'The uploaded file is not a valid .xlsx workbook',
      );
    }

    const metadata = this.readEmployeesMetadata(workbook);
    const parsedRows = this.readEmployeesRows(workbook, metadata);

    const createdBatch = await this.prisma.importBatch.create({
      data: {
        companyId: context.companyId,
        importType: ImportType.EMPLOYEES,
        schemaVersion: metadata.schemaVersion,
        validationVersion: 1,
        templateLanguage: metadata.templateLanguage,
        originalFileName: file.originalname,
        fileSizeBytes: file.size,
        fileHash,
        status: ImportBatchStatus.UPLOADED,
        executionMode: ImportExecutionMode.ALL_OR_NOTHING,
        totalRows: parsedRows.length,
        uploadedByUserId: context.actor.id,
        rows:
          parsedRows.length > 0
            ? {
                create: parsedRows.map((row) => ({
                  rowNumber: row.rowNumber,
                  sourceData: row.sourceData,
                  isValid: false,
                })),
              }
            : undefined,
      },
    });

    const batch = await this.prisma.importBatch.findUniqueOrThrow({
      where: { id: createdBatch.id },
      include: {
        company: { select: { id: true, code: true, name: true } },
        uploadedBy: {
          select: { id: true, fullName: true, username: true },
        },
      },
    });

    return {
      batch,
      parsedRows: {
        totalRows: parsedRows.length,
        firstRowNumber:
          parsedRows.length > 0 ? parsedRows[0].rowNumber : null,
        lastRowNumber:
          parsedRows.length > 0
            ? parsedRows[parsedRows.length - 1].rowNumber
            : null,
      },
      metadata,
    };
  }


  async uploadStationsTemplate(input: UploadStationsTemplateInput) {
    const context = await this.importsService.resolveImportContext(
      input.actorUserId,
      input.actorRoleName,
      input.actorCompanyId,
      input.targetCompanyId,
    );

    const file = input.file;
    if (!file) {
      this.fail('FILE_REQUIRED', 'Excel file is required');
    }

    this.validateFileBasics(file);

    const fileHash = createHash('sha256')
      .update(file.buffer)
      .digest('hex');

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(file.buffer as any);
    } catch {
      this.fail(
        'INVALID_FILE_TYPE',
        'The uploaded file is not a valid .xlsx workbook',
      );
    }

    const metadata = this.readStationsMetadata(workbook);
    const parsedRows = this.readStationsRows(workbook, metadata);

    const createdBatch = await this.prisma.importBatch.create({
      data: {
        companyId: context.companyId,
        importType: ImportType.STATIONS,
        schemaVersion: metadata.schemaVersion,
        validationVersion: 1,
        templateLanguage: metadata.templateLanguage,
        originalFileName: file.originalname,
        fileSizeBytes: file.size,
        fileHash,
        status: ImportBatchStatus.UPLOADED,
        executionMode: ImportExecutionMode.ALL_OR_NOTHING,
        totalRows: parsedRows.length,
        uploadedByUserId: context.actor.id,
        rows:
          parsedRows.length > 0
            ? {
                create: parsedRows.map((row) => ({
                  rowNumber: row.rowNumber,
                  sourceData: row.sourceData,
                  isValid: false,
                })),
              }
            : undefined,
      },
    });

    const batch = await this.prisma.importBatch.findUniqueOrThrow({
      where: { id: createdBatch.id },
      include: {
        company: { select: { id: true, code: true, name: true } },
        uploadedBy: {
          select: { id: true, fullName: true, username: true },
        },
      },
    });

    return {
      batch,
      parsedRows: {
        totalRows: parsedRows.length,
        firstRowNumber:
          parsedRows.length > 0 ? parsedRows[0].rowNumber : null,
        lastRowNumber:
          parsedRows.length > 0
            ? parsedRows[parsedRows.length - 1].rowNumber
            : null,
      },
      metadata: {
        templateType: metadata.templateType,
        schemaVersion: metadata.schemaVersion,
        templateLanguage: metadata.templateLanguage,
        dataSheet: metadata.dataSheet,
        maxRows: metadata.maxRows,
        executionMode: metadata.executionMode,
        mappings: metadata.mappings,
      },
    };
  }

  private validateFileBasics(file: Express.Multer.File) {
    const originalName = String(file.originalname || '').trim();

    if (!originalName.toLowerCase().endsWith('.xlsx')) {
      this.fail(
        'INVALID_FILE_TYPE',
        'Only .xlsx files are supported',
      );
    }

    if (!file.buffer || file.size <= 0) {
      this.fail(
        'INVALID_FILE_TYPE',
        'The uploaded Excel file is empty',
      );
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      this.fail(
        'FILE_SIZE_EXCEEDED',
        'File size must not exceed 5 MB',
      );
    }
  }

  private readProjectsMetadata(workbook: ExcelJS.Workbook) {
    const metaSheet = workbook.getWorksheet('_fleetfuel_meta');

    if (!metaSheet) {
      this.fail(
        'INVALID_TEMPLATE_TYPE',
        'Missing _fleetfuel_meta sheet',
      );
    }

    const meta = new Map<string, string>();

    for (let rowNumber = 2; rowNumber <= 9; rowNumber += 1) {
      const key = this.cellText(metaSheet.getCell(rowNumber, 1).value);
      const value = this.cellText(metaSheet.getCell(rowNumber, 2).value);

      if (key) {
        meta.set(key, value);
      }
    }

    const templateType = meta.get('templateType') || '';
    const schemaVersion = Number(meta.get('schemaVersion'));
    const templateLanguage = (meta.get('templateLanguage') || '')
      .trim()
      .toLowerCase();
    const dataSheet = meta.get('dataSheet') || '';
    const maxRows = Number(meta.get('maxRows'));
    const executionMode = meta.get('executionMode') || '';

    if (templateType !== PROJECTS_TEMPLATE_TYPE) {
      this.fail(
        'INVALID_TEMPLATE_TYPE',
        'This file is not a Projects import template',
      );
    }

    if (schemaVersion !== PROJECTS_SCHEMA_VERSION) {
      this.fail(
        'UNSUPPORTED_TEMPLATE_VERSION',
        `Projects template schema version ${String(
          meta.get('schemaVersion') || '',
        )} is not supported`,
      );
    }

    if (!['en', 'ar'].includes(templateLanguage)) {
      this.fail(
        'INVALID_COLUMN_MAPPING',
        'Template language must be en or ar',
      );
    }

    if (!dataSheet || !workbook.getWorksheet(dataSheet)) {
      this.fail(
        'INVALID_COLUMN_MAPPING',
        'The template data sheet is missing',
      );
    }

    if (maxRows !== PROJECTS_MAX_ROWS) {
      this.fail(
        'INVALID_COLUMN_MAPPING',
        'Template maxRows metadata is invalid',
      );
    }

    if (executionMode !== PROJECTS_EXECUTION_MODE) {
      this.fail(
        'INVALID_COLUMN_MAPPING',
        'Template execution mode is invalid',
      );
    }

    const mappings = this.readMappings(metaSheet);
    this.validateMappings(mappings);

    return {
      templateType,
      schemaVersion,
      templateLanguage,
      dataSheet,
      maxRows,
      executionMode,
      mappings,
    };
  }

  private readMappings(metaSheet: ExcelJS.Worksheet): MetaMapping[] {
    const mappings: MetaMapping[] = [];

    for (let rowNumber = 12; rowNumber <= metaSheet.rowCount; rowNumber += 1) {
      const columnHeader = this.cellText(
        metaSheet.getCell(rowNumber, 1).value,
      );
      const canonicalField = this.cellText(
        metaSheet.getCell(rowNumber, 2).value,
      );

      if (!columnHeader && !canonicalField) {
        continue;
      }

      mappings.push({
        columnHeader,
        canonicalField,
        required: this.cellText(
          metaSheet.getCell(rowNumber, 3).value,
        ),
        type: this.cellText(
          metaSheet.getCell(rowNumber, 4).value,
        ),
        rules: this.cellText(
          metaSheet.getCell(rowNumber, 5).value,
        ),
      });
    }

    return mappings;
  }

  private validateMappings(mappings: MetaMapping[]) {
    if (mappings.length !== PROJECTS_CANONICAL_FIELDS.length) {
      this.fail(
        'INVALID_COLUMN_MAPPING',
        'Projects template column mapping is incomplete',
      );
    }

    const canonicalFields = mappings.map((item) =>
      item.canonicalField.trim(),
    );

    const duplicates = canonicalFields.filter(
      (field, index) => canonicalFields.indexOf(field) !== index,
    );

    if (duplicates.length > 0) {
      this.fail(
        'INVALID_COLUMN_MAPPING',
        'Duplicate canonical field mapping found',
      );
    }

    for (const expectedField of PROJECTS_CANONICAL_FIELDS) {
      if (!canonicalFields.includes(expectedField)) {
        this.fail(
          'MISSING_REQUIRED_COLUMN',
          `Missing canonical field mapping: ${expectedField}`,
        );
      }
    }

    for (const field of canonicalFields) {
      if (
        !PROJECTS_CANONICAL_FIELDS.includes(
          field as (typeof PROJECTS_CANONICAL_FIELDS)[number],
        )
      ) {
        this.fail(
          'INVALID_COLUMN_MAPPING',
          `Unsupported canonical field mapping: ${field}`,
        );
      }
    }

    const headers = mappings.map((item) => item.columnHeader.trim());

    if (headers.some((header) => !header)) {
      this.fail(
        'INVALID_COLUMN_MAPPING',
        'Template contains an empty visible column header',
      );
    }

    if (new Set(headers).size !== headers.length) {
      this.fail(
        'INVALID_COLUMN_MAPPING',
        'Template contains duplicate visible column headers',
      );
    }
  }

  private readProjectsRows(
    workbook: ExcelJS.Workbook,
    metadata: {
      dataSheet: string;
      maxRows: number;
      mappings: MetaMapping[];
    },
  ): ParsedImportRow[] {
    const worksheet = workbook.getWorksheet(metadata.dataSheet);

    if (!worksheet) {
      this.fail(
        'INVALID_COLUMN_MAPPING',
        'The template data sheet is missing',
      );
    }

    const headerToColumn = new Map<string, number>();

    for (let columnNumber = 1; columnNumber <= worksheet.columnCount; columnNumber += 1) {
      const header = this.cellText(
        worksheet.getCell(1, columnNumber).value,
      );

      if (!header) {
        continue;
      }

      if (headerToColumn.has(header)) {
        this.fail(
          'INVALID_COLUMN_MAPPING',
          `Duplicate data sheet column header: ${header}`,
        );
      }

      headerToColumn.set(header, columnNumber);
    }

    for (const mapping of metadata.mappings) {
      if (!headerToColumn.has(mapping.columnHeader)) {
        this.fail(
          'MISSING_REQUIRED_COLUMN',
          `Missing data sheet column: ${mapping.columnHeader}`,
        );
      }
    }

    const mappedHeaders = new Set(
      metadata.mappings.map((mapping) => mapping.columnHeader),
    );

    for (const header of headerToColumn.keys()) {
      if (!mappedHeaders.has(header)) {
        this.fail(
          'INVALID_COLUMN_MAPPING',
          `Unsupported data sheet column: ${header}`,
        );
      }
    }

    const parsedRows: ParsedImportRow[] = [];

    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const sourceData: Record<string, Prisma.InputJsonValue> = {};
      let hasAnyValue = false;

      for (const mapping of metadata.mappings) {
        const columnNumber = headerToColumn.get(mapping.columnHeader);

        if (!columnNumber) {
          continue;
        }

        const rawValue = worksheet.getCell(
          rowNumber,
          columnNumber,
        ).value;

        const jsonValue = this.toJsonValue(rawValue);

        if (!this.isBlankJsonValue(jsonValue)) {
          hasAnyValue = true;
        }

        sourceData[mapping.canonicalField] = jsonValue;
      }

      if (!hasAnyValue) {
        continue;
      }

      parsedRows.push({
        rowNumber,
        sourceData,
      });

      if (parsedRows.length > metadata.maxRows) {
        this.fail(
          'ROW_LIMIT_EXCEEDED',
          `Projects import cannot exceed ${metadata.maxRows} data rows`,
        );
      }
    }

    return parsedRows;
  }


  private readEmployeesMetadata(workbook: ExcelJS.Workbook) {
    const metaSheet = workbook.getWorksheet('_fleetfuel_meta');
    if (!metaSheet) {
      this.fail('INVALID_TEMPLATE_TYPE', 'Missing _fleetfuel_meta sheet');
    }

    const meta = new Map<string, string>();
    for (let rowNumber = 2; rowNumber <= 9; rowNumber += 1) {
      const key = this.cellText(metaSheet.getCell(rowNumber, 1).value);
      const value = this.cellText(metaSheet.getCell(rowNumber, 2).value);
      if (key) meta.set(key, value);
    }

    const templateType = meta.get('templateType') || '';
    const schemaVersion = Number(meta.get('schemaVersion'));
    const templateLanguage = (meta.get('templateLanguage') || '')
      .trim()
      .toLowerCase();
    const dataSheet = meta.get('dataSheet') || '';
    const maxRows = Number(meta.get('maxRows'));
    const executionMode = meta.get('executionMode') || '';
    const defaultStatus = meta.get('defaultStatus') || '';
    const linkedUserPolicy = meta.get('linkedUserPolicy') || '';

    if (templateType !== EMPLOYEES_TEMPLATE_TYPE) {
      this.fail(
        'INVALID_TEMPLATE_TYPE',
        'This file is not an Employees import template',
      );
    }
    if (schemaVersion !== EMPLOYEES_SCHEMA_VERSION) {
      this.fail(
        'UNSUPPORTED_TEMPLATE_VERSION',
        `Employees template schema version ${String(meta.get('schemaVersion') || '')} is not supported`,
      );
    }
    if (!['en', 'ar'].includes(templateLanguage)) {
      this.fail('INVALID_COLUMN_MAPPING', 'Template language must be en or ar');
    }
    if (!dataSheet || !workbook.getWorksheet(dataSheet)) {
      this.fail('INVALID_COLUMN_MAPPING', 'The template data sheet is missing');
    }
    if (maxRows !== EMPLOYEES_MAX_ROWS) {
      this.fail('INVALID_COLUMN_MAPPING', 'Template maxRows metadata is invalid');
    }
    if (executionMode !== EMPLOYEES_EXECUTION_MODE) {
      this.fail('INVALID_COLUMN_MAPPING', 'Template execution mode is invalid');
    }
    if (defaultStatus !== 'ON_DUTY' || linkedUserPolicy !== 'UNLINKED') {
      this.fail(
        'INVALID_COLUMN_MAPPING',
        'Employees template default employee policy is invalid',
      );
    }

    const mappings = this.readMappings(metaSheet);
    this.validateEmployeeMappings(mappings);

    return {
      templateType,
      schemaVersion,
      templateLanguage,
      dataSheet,
      maxRows,
      executionMode,
      defaultStatus,
      linkedUserPolicy,
      mappings,
    };
  }

  private validateEmployeeMappings(mappings: MetaMapping[]) {
    if (mappings.length !== EMPLOYEES_CANONICAL_FIELDS.length) {
      this.fail(
        'INVALID_COLUMN_MAPPING',
        'Employees template column mapping is incomplete',
      );
    }

    const canonicalFields = mappings.map((item) => item.canonicalField.trim());
    if (new Set(canonicalFields).size !== canonicalFields.length) {
      this.fail('INVALID_COLUMN_MAPPING', 'Duplicate canonical field mapping found');
    }

    for (const expectedField of EMPLOYEES_CANONICAL_FIELDS) {
      if (!canonicalFields.includes(expectedField)) {
        this.fail(
          'MISSING_REQUIRED_COLUMN',
          `Missing canonical field mapping: ${expectedField}`,
        );
      }
    }

    for (const field of canonicalFields) {
      if (!EMPLOYEES_CANONICAL_FIELDS.includes(
        field as (typeof EMPLOYEES_CANONICAL_FIELDS)[number],
      )) {
        this.fail(
          'INVALID_COLUMN_MAPPING',
          `Unsupported canonical field mapping: ${field}`,
        );
      }
    }

    const headers = mappings.map((item) => item.columnHeader.trim());
    if (headers.some((header) => !header)) {
      this.fail(
        'INVALID_COLUMN_MAPPING',
        'Template contains an empty visible column header',
      );
    }
    if (new Set(headers).size !== headers.length) {
      this.fail(
        'INVALID_COLUMN_MAPPING',
        'Template contains duplicate visible column headers',
      );
    }
  }

  private readEmployeesRows(
    workbook: ExcelJS.Workbook,
    metadata: {
      dataSheet: string;
      maxRows: number;
      mappings: MetaMapping[];
    },
  ): ParsedImportRow[] {
    const worksheet = workbook.getWorksheet(metadata.dataSheet);
    if (!worksheet) {
      this.fail('INVALID_COLUMN_MAPPING', 'The template data sheet is missing');
    }

    const headerToColumn = new Map<string, number>();
    for (
      let columnNumber = 1;
      columnNumber <= worksheet.columnCount;
      columnNumber += 1
    ) {
      const header = this.cellText(worksheet.getCell(1, columnNumber).value);
      if (!header) continue;
      if (headerToColumn.has(header)) {
        this.fail(
          'INVALID_COLUMN_MAPPING',
          `Duplicate data sheet column header: ${header}`,
        );
      }
      headerToColumn.set(header, columnNumber);
    }

    for (const mapping of metadata.mappings) {
      if (!headerToColumn.has(mapping.columnHeader)) {
        this.fail(
          'MISSING_REQUIRED_COLUMN',
          `Missing data sheet column: ${mapping.columnHeader}`,
        );
      }
    }

    const mappedHeaders = new Set(
      metadata.mappings.map((mapping) => mapping.columnHeader),
    );
    for (const header of headerToColumn.keys()) {
      if (!mappedHeaders.has(header)) {
        this.fail(
          'INVALID_COLUMN_MAPPING',
          `Unsupported data sheet column: ${header}`,
        );
      }
    }

    const parsedRows: ParsedImportRow[] = [];
    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const sourceData: Record<string, Prisma.InputJsonValue> = {};
      let hasAnyValue = false;

      for (const mapping of metadata.mappings) {
        const columnNumber = headerToColumn.get(mapping.columnHeader);
        if (!columnNumber) continue;

        const jsonValue = this.toJsonValue(
          worksheet.getCell(rowNumber, columnNumber).value,
        );
        if (!this.isBlankJsonValue(jsonValue)) hasAnyValue = true;
        sourceData[mapping.canonicalField] = jsonValue;
      }

      if (!hasAnyValue) continue;
      parsedRows.push({ rowNumber, sourceData });

      if (parsedRows.length > metadata.maxRows) {
        this.fail(
          'ROW_LIMIT_EXCEEDED',
          `Employees import cannot exceed ${metadata.maxRows} data rows`,
        );
      }
    }

    return parsedRows;
  }



  private readStationsMetadata(workbook: ExcelJS.Workbook) {
    const metaSheet = workbook.getWorksheet('_fleetfuel_meta');
    if (!metaSheet) {
      this.fail('INVALID_TEMPLATE_TYPE', 'Missing _fleetfuel_meta sheet');
    }

    const meta = new Map<string, string>();
    for (let rowNumber = 2; rowNumber <= 9; rowNumber += 1) {
      const key = this.cellText(metaSheet.getCell(rowNumber, 1).value);
      const value = this.cellText(metaSheet.getCell(rowNumber, 2).value);
      if (key) meta.set(key, value);
    }

    const templateType = meta.get('templateType') || '';
    const schemaVersion = Number(meta.get('schemaVersion'));
    const templateLanguage = (meta.get('templateLanguage') || '')
      .trim()
      .toLowerCase();
    const dataSheet = meta.get('dataSheet') || '';
    const maxRows = Number(meta.get('maxRows'));
    const executionMode = meta.get('executionMode') || '';
    const defaultStatus = meta.get('defaultStatus') || '';

    if (templateType !== STATIONS_TEMPLATE_TYPE) {
      this.fail(
        'INVALID_TEMPLATE_TYPE',
        'This file is not a Stations import template',
      );
    }
    if (schemaVersion !== STATIONS_SCHEMA_VERSION) {
      this.fail(
        'UNSUPPORTED_TEMPLATE_VERSION',
        `Stations template schema version ${String(meta.get('schemaVersion') || '')} is not supported`,
      );
    }
    if (!['en', 'ar'].includes(templateLanguage)) {
      this.fail('INVALID_COLUMN_MAPPING', 'Template language must be en or ar');
    }
    if (!dataSheet || !workbook.getWorksheet(dataSheet)) {
      this.fail('INVALID_COLUMN_MAPPING', 'The template data sheet is missing');
    }
    if (maxRows !== STATIONS_MAX_ROWS) {
      this.fail('INVALID_COLUMN_MAPPING', 'Template maxRows metadata is invalid');
    }
    if (executionMode !== STATIONS_EXECUTION_MODE) {
      this.fail('INVALID_COLUMN_MAPPING', 'Template execution mode is invalid');
    }
    if (defaultStatus !== 'ACTIVE') {
      this.fail('INVALID_COLUMN_MAPPING', 'Stations template default status is invalid');
    }

    const mappings = this.readMappings(metaSheet);
    this.validateStationMappings(mappings);

    return {
      templateType,
      schemaVersion,
      templateLanguage,
      dataSheet,
      maxRows,
      executionMode,
      defaultStatus,
      mappings,
    };
  }

  private validateStationMappings(mappings: MetaMapping[]) {
    if (mappings.length !== STATIONS_CANONICAL_FIELDS.length) {
      this.fail(
        'INVALID_COLUMN_MAPPING',
        'Stations template column mapping is incomplete',
      );
    }

    const canonicalFields = mappings.map((item) => item.canonicalField.trim());
    if (new Set(canonicalFields).size !== canonicalFields.length) {
      this.fail('INVALID_COLUMN_MAPPING', 'Duplicate canonical field mapping found');
    }

    for (const expectedField of STATIONS_CANONICAL_FIELDS) {
      if (!canonicalFields.includes(expectedField)) {
        this.fail(
          'MISSING_REQUIRED_COLUMN',
          `Missing canonical field mapping: ${expectedField}`,
        );
      }
    }

    for (const field of canonicalFields) {
      if (!STATIONS_CANONICAL_FIELDS.includes(
        field as (typeof STATIONS_CANONICAL_FIELDS)[number],
      )) {
        this.fail(
          'INVALID_COLUMN_MAPPING',
          `Unsupported canonical field mapping: ${field}`,
        );
      }
    }

    const headers = mappings.map((item) => item.columnHeader.trim());
    if (headers.some((header) => !header)) {
      this.fail(
        'INVALID_COLUMN_MAPPING',
        'Template contains an empty visible column header',
      );
    }
    if (new Set(headers).size !== headers.length) {
      this.fail(
        'INVALID_COLUMN_MAPPING',
        'Template contains duplicate visible column headers',
      );
    }
  }

  private readStationsRows(
    workbook: ExcelJS.Workbook,
    metadata: {
      dataSheet: string;
      maxRows: number;
      mappings: MetaMapping[];
    },
  ): ParsedImportRow[] {
    const worksheet = workbook.getWorksheet(metadata.dataSheet);
    if (!worksheet) {
      this.fail('INVALID_COLUMN_MAPPING', 'The template data sheet is missing');
    }

    const headerToColumn = new Map<string, number>();
    for (
      let columnNumber = 1;
      columnNumber <= worksheet.columnCount;
      columnNumber += 1
    ) {
      const header = this.cellText(worksheet.getCell(1, columnNumber).value);
      if (!header) continue;
      if (headerToColumn.has(header)) {
        this.fail(
          'INVALID_COLUMN_MAPPING',
          `Duplicate data sheet column header: ${header}`,
        );
      }
      headerToColumn.set(header, columnNumber);
    }

    for (const mapping of metadata.mappings) {
      if (!headerToColumn.has(mapping.columnHeader)) {
        this.fail(
          'MISSING_REQUIRED_COLUMN',
          `Missing data sheet column: ${mapping.columnHeader}`,
        );
      }
    }

    const mappedHeaders = new Set(
      metadata.mappings.map((mapping) => mapping.columnHeader),
    );
    for (const header of headerToColumn.keys()) {
      if (!mappedHeaders.has(header)) {
        this.fail(
          'INVALID_COLUMN_MAPPING',
          `Unsupported data sheet column: ${header}`,
        );
      }
    }

    const parsedRows: ParsedImportRow[] = [];
    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const sourceData: Record<string, Prisma.InputJsonValue> = {};
      let hasAnyValue = false;

      for (const mapping of metadata.mappings) {
        const columnNumber = headerToColumn.get(mapping.columnHeader);
        if (!columnNumber) continue;

        const jsonValue = this.toJsonValue(
          worksheet.getCell(rowNumber, columnNumber).value,
        );
        if (!this.isBlankJsonValue(jsonValue)) hasAnyValue = true;
        sourceData[mapping.canonicalField] = jsonValue;
      }

      if (!hasAnyValue) continue;
      parsedRows.push({ rowNumber, sourceData });

      if (parsedRows.length > metadata.maxRows) {
        this.fail(
          'ROW_LIMIT_EXCEEDED',
          `Stations import cannot exceed ${metadata.maxRows} data rows`,
        );
      }
    }

    return parsedRows;
  }

  private toJsonValue(
    value: ExcelJS.CellValue,
  ): Prisma.InputJsonValue {
    if (value === null || value === undefined) {
      return '';
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value;
    }

    if (typeof value === 'object') {
      if (
        'result' in value &&
        value.result !== null &&
        value.result !== undefined
      ) {
        return this.toJsonValue(value.result as ExcelJS.CellValue);
      }

      if ('text' in value && typeof value.text === 'string') {
        return value.text;
      }

      if ('richText' in value && Array.isArray(value.richText)) {
        return value.richText
          .map((part) => part.text)
          .join('');
      }

      if ('hyperlink' in value) {
        return String(value.text || value.hyperlink || '');
      }
    }

    return String(value);
  }

  private isBlankJsonValue(value: Prisma.InputJsonValue) {
    return typeof value === 'string'
      ? value.trim() === ''
      : value === null;
  }

  private cellText(value: ExcelJS.CellValue): string {
    if (value === null || value === undefined) {
      return '';
    }

    if (typeof value === 'object') {
      if ('text' in value && typeof value.text === 'string') {
        return value.text.trim();
      }

      if (
        'result' in value &&
        value.result !== null &&
        value.result !== undefined
      ) {
        return String(value.result).trim();
      }

      if ('richText' in value && Array.isArray(value.richText)) {
        return value.richText
          .map((part) => part.text)
          .join('')
          .trim();
      }
    }

    return String(value).trim();
  }

  private fail(code: string, message: string): never {
    throw new BadRequestException({
      code,
      message,
    });
  }
}

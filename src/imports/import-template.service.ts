import { BadRequestException, Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';

export type ImportTemplateLanguage = 'en' | 'ar';

const PROJECTS_TEMPLATE_TYPE = 'PROJECTS';
const PROJECTS_SCHEMA_VERSION = 1;
const PROJECTS_MAX_ROWS = 500;

const PROJECT_COLUMNS = [
  {
    canonicalField: 'projectCode',
    required: true,
    type: 'text',
    maxLength: 50,
    en: 'Project Code',
    ar: 'كود المشروع',
  },
  {
    canonicalField: 'projectName',
    required: true,
    type: 'text',
    maxLength: 150,
    en: 'Project Name',
    ar: 'اسم المشروع',
  },
  {
    canonicalField: 'location',
    required: false,
    type: 'text',
    maxLength: 150,
    en: 'Location',
    ar: 'الموقع',
  },
  {
    canonicalField: 'description',
    required: false,
    type: 'text',
    maxLength: 500,
    en: 'Description',
    ar: 'الوصف',
  },
  {
    canonicalField: 'status',
    required: true,
    type: 'enum',
    en: 'Status',
    ar: 'الحالة',
  },
  {
    canonicalField: 'projectStartDate',
    required: true,
    type: 'date',
    en: 'Project Start Date',
    ar: 'تاريخ بداية المشروع',
  },
  {
    canonicalField: 'basePricePerLiter',
    required: true,
    type: 'number',
    minExclusive: 0,
    en: 'Base Price / Liter',
    ar: 'السعر الأساسي / لتر',
  },
  {
    canonicalField: 'transportCostPerLiter',
    required: false,
    type: 'number',
    minInclusive: 0,
    defaultValue: 0,
    en: 'Transport Cost / Liter',
    ar: 'تكلفة النقل / لتر',
  },
  {
    canonicalField: 'vatRate',
    required: false,
    type: 'number',
    minInclusive: 0,
    maxInclusive: 100,
    defaultValue: 0,
    en: 'VAT %',
    ar: 'ضريبة القيمة المضافة %',
  },
] as const;

@Injectable()
export class ImportTemplateService {
  normalizeTemplateLanguage(language?: string): ImportTemplateLanguage {
    const normalized = String(language || 'en').trim().toLowerCase();

    if (normalized === 'en' || normalized === 'ar') {
      return normalized;
    }

    throw new BadRequestException('Template language must be en or ar');
  }

  async buildProjectsTemplate(languageInput?: string) {
    const language = this.normalizeTemplateLanguage(languageInput);
    const isArabic = language === 'ar';

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Fleet Fuel PRO';
    workbook.created = new Date();
    workbook.modified = new Date();

    const dataSheetName = isArabic ? 'المشاريع' : 'Projects';
    const instructionsSheetName = isArabic ? 'تعليمات' : 'Instructions';

    const instructions = workbook.addWorksheet(instructionsSheetName, {
      views: [{ rightToLeft: isArabic }],
    });

    instructions.columns = [{ width: 110 }];
    instructions.getCell('A1').value = isArabic
      ? 'Fleet Fuel PRO - نموذج استيراد المشاريع'
      : 'Fleet Fuel PRO - Projects Import Template';
    instructions.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
    instructions.getCell('A1').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF0F172A' },
    };
    instructions.getCell('A1').alignment = {
      horizontal: isArabic ? 'right' : 'left',
      vertical: 'middle',
    };
    instructions.getRow(1).height = 28;

    const instructionsText = isArabic
      ? [
          '1. أدخل البيانات في ورقة "المشاريع" فقط ولا تغيّر أسماء الأعمدة.',
          '2. الحقول المطلوبة: كود المشروع، اسم المشروع، الحالة، تاريخ بداية المشروع، السعر الأساسي / لتر.',
          '3. الحالة يجب أن تكون "نشط" أو "غير نشط" فقط.',
          '4. تكلفة النقل اختيارية وتساوي صفر عند تركها فارغة. ضريبة القيمة المضافة اختيارية من 0 إلى 100 وتساوي صفر عند تركها فارغة.',
          '5. الحد الأقصى للاستيراد في هذه النسخة هو 500 مشروع.',
          '6. لا تحذف أو تعدل ورقة النظام المخفية _fleetfuel_meta.',
        ]
      : [
          '1. Enter data only in the "Projects" sheet and do not rename the columns.',
          '2. Required fields: Project Code, Project Name, Status, Project Start Date, Base Price / Liter.',
          '3. Status must be either "Active" or "Inactive".',
          '4. Transport Cost is optional and defaults to 0. VAT is optional from 0 to 100 and defaults to 0.',
          '5. The maximum import size in this version is 500 projects.',
          '6. Do not delete or modify the hidden system sheet _fleetfuel_meta.',
        ];

    instructionsText.forEach((text, index) => {
      const cell = instructions.getCell(index + 3, 1);
      cell.value = text;
      cell.alignment = {
        horizontal: isArabic ? 'right' : 'left',
        vertical: 'top',
        wrapText: true,
      };
      cell.font = { size: 11 };
      instructions.getRow(index + 3).height = 26;
    });

    const projects = workbook.addWorksheet(dataSheetName, {
      views: [{ state: 'frozen', ySplit: 1, rightToLeft: isArabic }],
    });

    projects.columns = PROJECT_COLUMNS.map((column) => ({
      header: column[language],
      key: column.canonicalField,
      width:
        column.canonicalField === 'description'
          ? 34
          : column.canonicalField === 'projectName' ||
              column.canonicalField === 'location'
            ? 24
            : 20,
    }));

    const headerRow = projects.getRow(1);
    headerRow.height = 28;
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF0F172A' },
    };
    headerRow.alignment = {
      horizontal: 'center',
      vertical: 'middle',
      wrapText: true,
    };

    for (let row = 2; row <= PROJECTS_MAX_ROWS + 1; row += 1) {
      const statusCell = projects.getCell(row, 5);
      statusCell.dataValidation = {
        type: 'list',
        allowBlank: false,
        formulae: [isArabic ? '"نشط,غير نشط"' : '"Active,Inactive"'],
        showErrorMessage: true,
        errorTitle: isArabic ? 'قيمة غير صحيحة' : 'Invalid value',
        error: isArabic
          ? 'اختر الحالة من القائمة فقط.'
          : 'Select status from the list only.',
      };

      const dateCell = projects.getCell(row, 6);
      dateCell.numFmt = 'yyyy-mm-dd';
      dateCell.dataValidation = {
        type: 'date',
        operator: 'between',
        allowBlank: false,
        formulae: [new Date(1900, 0, 1), new Date(9999, 11, 31)],
        showErrorMessage: true,
        errorTitle: isArabic ? 'تاريخ غير صحيح' : 'Invalid date',
        error: isArabic
          ? 'أدخل تاريخًا صحيحًا.'
          : 'Enter a valid date.',
      };

      projects.getCell(row, 7).dataValidation = {
        type: 'decimal',
        operator: 'greaterThan',
        allowBlank: false,
        formulae: [0],
      };

      projects.getCell(row, 8).dataValidation = {
        type: 'decimal',
        operator: 'greaterThanOrEqual',
        allowBlank: true,
        formulae: [0],
      };

      projects.getCell(row, 9).dataValidation = {
        type: 'decimal',
        operator: 'between',
        allowBlank: true,
        formulae: [0, 100],
      };
    }

    projects.getColumn(6).numFmt = 'yyyy-mm-dd';
    projects.getColumn(7).numFmt = '0.000000';
    projects.getColumn(8).numFmt = '0.000000';
    projects.getColumn(9).numFmt = '0.00';

    const meta = workbook.addWorksheet('_fleetfuel_meta');
    meta.state = 'veryHidden';

    meta.addRows([
      ['metaKey', 'metaValue'],
      ['templateType', PROJECTS_TEMPLATE_TYPE],
      ['schemaVersion', PROJECTS_SCHEMA_VERSION],
      ['templateLanguage', language],
      ['dataSheet', dataSheetName],
      ['maxRows', PROJECTS_MAX_ROWS],
      ['executionMode', 'ALL_OR_NOTHING'],
      ['status.ACTIVE', isArabic ? 'نشط' : 'Active'],
      ['status.INACTIVE', isArabic ? 'غير نشط' : 'Inactive'],
      [],
      ['columnHeader', 'canonicalField', 'required', 'type', 'rules'],
      ...PROJECT_COLUMNS.map((column) => [
        column[language],
        column.canonicalField,
        column.required ? 'true' : 'false',
        column.type,
        JSON.stringify({
          ...('maxLength' in column ? { maxLength: column.maxLength } : {}),
          ...('minExclusive' in column
            ? { minExclusive: column.minExclusive }
            : {}),
          ...('minInclusive' in column
            ? { minInclusive: column.minInclusive }
            : {}),
          ...('maxInclusive' in column
            ? { maxInclusive: column.maxInclusive }
            : {}),
          ...('defaultValue' in column
            ? { defaultValue: column.defaultValue }
            : {}),
        }),
      ]),
    ]);

    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = `FleetFuelPRO_Projects_Import_Template_v${PROJECTS_SCHEMA_VERSION}_${language}.xlsx`;

    return {
      buffer: Buffer.from(buffer),
      fileName,
      language,
      templateType: PROJECTS_TEMPLATE_TYPE,
      schemaVersion: PROJECTS_SCHEMA_VERSION,
    };
  }
}

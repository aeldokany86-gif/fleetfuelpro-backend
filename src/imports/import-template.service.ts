import { BadRequestException, Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';

export type ImportTemplateLanguage = 'en' | 'ar';

const PROJECTS_TEMPLATE_TYPE = 'PROJECTS';
const PROJECTS_SCHEMA_VERSION = 1;
const PROJECTS_MAX_ROWS = 500;

const EMPLOYEES_TEMPLATE_TYPE = 'EMPLOYEES';
const EMPLOYEES_SCHEMA_VERSION = 1;
const EMPLOYEES_MAX_ROWS = 500;


const STATIONS_TEMPLATE_TYPE = 'STATIONS';
const STATIONS_SCHEMA_VERSION = 1;
const STATIONS_MAX_ROWS = 500;

const STATION_COLUMNS = [
  {
    canonicalField: 'stationId',
    required: true,
    type: 'text',
    en: 'Station ID',
    ar: 'كود المحطة',
  },
  {
    canonicalField: 'stationName',
    required: false,
    type: 'text',
    en: 'Station Name',
    ar: 'اسم المحطة',
  },
  {
    canonicalField: 'stationType',
    required: false,
    type: 'text',
    en: 'Station Type',
    ar: 'نوع المحطة',
  },
  {
    canonicalField: 'capacity',
    required: false,
    type: 'number',
    en: 'Capacity',
    ar: 'السعة',
  },
  {
    canonicalField: 'projectCode',
    required: true,
    type: 'text',
    en: 'Project Code',
    ar: 'كود المشروع',
  },
  {
    canonicalField: 'openingBalance',
    required: true,
    type: 'number',
    minInclusive: 0,
    en: 'Opening Balance',
    ar: 'الرصيد الافتتاحي',
  },
  {
    canonicalField: 'currentCounter',
    required: true,
    type: 'number',
    minInclusive: 0,
    en: 'Current Counter',
    ar: 'العداد الحالي',
  },
] as const;

const EMPLOYEE_COLUMNS = [
  {
    canonicalField: 'employeeId',
    required: true,
    type: 'text',
    en: 'Employee ID',
    ar: 'كود الموظف',
  },
  {
    canonicalField: 'employeeName',
    required: true,
    type: 'text',
    en: 'Employee Name',
    ar: 'اسم الموظف',
  },
  {
    canonicalField: 'phone',
    required: false,
    type: 'text',
    en: 'Phone',
    ar: 'رقم الجوال',
  },
  {
    canonicalField: 'email',
    required: false,
    type: 'text',
    en: 'Email',
    ar: 'البريد الإلكتروني',
  },
  {
    canonicalField: 'projectCode',
    required: true,
    type: 'text',
    en: 'Project Code',
    ar: 'كود المشروع',
  },
  {
    canonicalField: 'jobTitle',
    required: false,
    type: 'text',
    defaultValue: 'Operator',
    en: 'Job Title',
    ar: 'المسمى الوظيفي',
  },
] as const;

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

  async buildEmployeesTemplate(languageInput?: string) {
    const language = this.normalizeTemplateLanguage(languageInput);
    const isArabic = language === 'ar';

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Fleet Fuel PRO';
    workbook.created = new Date();
    workbook.modified = new Date();

    const dataSheetName = isArabic ? 'الموظفين' : 'Employees';
    const instructionsSheetName = isArabic ? 'تعليمات' : 'Instructions';

    const instructions = workbook.addWorksheet(instructionsSheetName, {
      views: [{ rightToLeft: isArabic }],
    });

    instructions.columns = [{ width: 110 }];
    instructions.getCell('A1').value = isArabic
      ? 'Fleet Fuel PRO - نموذج استيراد الموظفين'
      : 'Fleet Fuel PRO - Employees Import Template';
    instructions.getCell('A1').font = {
      bold: true,
      size: 16,
      color: { argb: 'FFFFFFFF' },
    };
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
          '1. أدخل البيانات في ورقة "الموظفين" فقط ولا تغيّر أسماء الأعمدة.',
          '2. الحقول المطلوبة: كود الموظف، اسم الموظف، كود المشروع.',
          '3. كود المشروع لا يتأثر بحالة الأحرف؛ مثال P001 و p001 يشيران إلى نفس المشروع.',
          '4. يجب أن يشير كود المشروع إلى مشروع نشط داخل نفس الشركة.',
          '5. رقم الجوال والبريد الإلكتروني والمسمى الوظيفي حقول اختيارية. المسمى الوظيفي الافتراضي هو Operator.',
          '6. حالة كل موظف مستورد تُنشأ تلقائيًا ON_DUTY ولا يتم ربطه بأي مستخدم نظام.',
          '7. الحد الأقصى للاستيراد في هذه النسخة هو 500 موظف.',
          '8. لا تحذف أو تعدل ورقة النظام المخفية _fleetfuel_meta.',
        ]
      : [
          '1. Enter data only in the "Employees" sheet and do not rename the columns.',
          '2. Required fields: Employee ID, Employee Name, Project Code.',
          '3. Project Code is case-insensitive; for example P001 and p001 identify the same project.',
          '4. Project Code must identify an active project in the same company.',
          '5. Phone, Email, and Job Title are optional. Job Title defaults to Operator.',
          '6. Every imported employee is created automatically with status ON_DUTY and without a linked system user.',
          '7. The maximum import size in this version is 500 employees.',
          '8. Do not delete or modify the hidden system sheet _fleetfuel_meta.',
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

    const employees = workbook.addWorksheet(dataSheetName, {
      views: [{ state: 'frozen', ySplit: 1, rightToLeft: isArabic }],
    });

    employees.columns = EMPLOYEE_COLUMNS.map((column) => ({
      header: column[language],
      key: column.canonicalField,
      width:
        column.canonicalField === 'employeeName' ||
        column.canonicalField === 'email' ||
        column.canonicalField === 'jobTitle'
          ? 26
          : 20,
    }));

    const headerRow = employees.getRow(1);
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

    // Keep import identifiers/contact values as text.
    // Applying the format only at column level is not sufficient in all Excel
    // versions for previously blank cells, so pre-style every allowed data cell.
    for (let column = 1; column <= EMPLOYEE_COLUMNS.length; column += 1) {
      employees.getColumn(column).numFmt = '@';
    }

    for (let row = 2; row <= EMPLOYEES_MAX_ROWS + 1; row += 1) {
      for (let column = 1; column <= EMPLOYEE_COLUMNS.length; column += 1) {
        employees.getCell(row, column).numFmt = '@';
      }
    }

    const meta = workbook.addWorksheet('_fleetfuel_meta');
    meta.state = 'veryHidden';
    meta.addRows([
      ['metaKey', 'metaValue'],
      ['templateType', EMPLOYEES_TEMPLATE_TYPE],
      ['schemaVersion', EMPLOYEES_SCHEMA_VERSION],
      ['templateLanguage', language],
      ['dataSheet', dataSheetName],
      ['maxRows', EMPLOYEES_MAX_ROWS],
      ['executionMode', 'ALL_OR_NOTHING'],
      ['defaultStatus', 'ON_DUTY'],
      ['linkedUserPolicy', 'UNLINKED'],
      [],
      ['columnHeader', 'canonicalField', 'required', 'type', 'rules'],
      ...EMPLOYEE_COLUMNS.map((column) => [
        column[language],
        column.canonicalField,
        column.required ? 'true' : 'false',
        column.type,
        JSON.stringify({
          ...('defaultValue' in column
            ? { defaultValue: column.defaultValue }
            : {}),
        }),
      ]),
    ]);

    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = `FleetFuelPRO_Employees_Import_Template_v${EMPLOYEES_SCHEMA_VERSION}_${language}.xlsx`;

    return {
      buffer: Buffer.from(buffer),
      fileName,
      language,
      templateType: EMPLOYEES_TEMPLATE_TYPE,
      schemaVersion: EMPLOYEES_SCHEMA_VERSION,
    };
  }


  async buildStationsTemplate(languageInput?: string) {
    const language = this.normalizeTemplateLanguage(languageInput);
    const isArabic = language === 'ar';

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Fleet Fuel PRO';
    workbook.created = new Date();
    workbook.modified = new Date();

    const dataSheetName = isArabic ? 'المحطات' : 'Stations';
    const instructionsSheetName = isArabic ? 'تعليمات' : 'Instructions';

    const instructions = workbook.addWorksheet(instructionsSheetName, {
      views: [{ rightToLeft: isArabic }],
    });

    instructions.columns = [{ width: 110 }];
    instructions.getCell('A1').value = isArabic
      ? 'Fleet Fuel PRO - نموذج استيراد المحطات'
      : 'Fleet Fuel PRO - Stations Import Template';
    instructions.getCell('A1').font = {
      bold: true,
      size: 16,
      color: { argb: 'FFFFFFFF' },
    };
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
          '1. أدخل البيانات في ورقة "المحطات" فقط ولا تغيّر أسماء الأعمدة.',
          '2. الحقول المطلوبة: كود المحطة، كود المشروع، الرصيد الافتتاحي، العداد الحالي.',
          '3. كود المحطة وكود المشروع لا يتأثران بحالة الأحرف؛ مثال ST001 و st001 يعتبران نفس الكود.',
          '4. يجب أن يشير كود المشروع إلى مشروع نشط داخل نفس الشركة.',
          '5. اسم المحطة ونوع المحطة والسعة حقول اختيارية.',
          '6. الرصيد الافتتاحي والعداد الحالي يجب أن يكونا صفرًا أو أكبر.',
          '7. كل محطة مستوردة تُنشأ تلقائيًا بحالة ACTIVE، ويبدأ المخزون الحالي من الرصيد الافتتاحي.',
          '8. الحد الأقصى للاستيراد في هذه النسخة هو 500 محطة.',
          '9. لا تحذف أو تعدل ورقة النظام المخفية _fleetfuel_meta.',
        ]
      : [
          '1. Enter data only in the "Stations" sheet and do not rename the columns.',
          '2. Required fields: Station ID, Project Code, Opening Balance, Current Counter.',
          '3. Station ID and Project Code are case-insensitive; for example ST001 and st001 identify the same code.',
          '4. Project Code must identify an active project in the same company.',
          '5. Station Name, Station Type, and Capacity are optional.',
          '6. Opening Balance and Current Counter must be zero or positive numbers.',
          '7. Every imported station is created automatically with status ACTIVE, and current stock starts from Opening Balance.',
          '8. The maximum import size in this version is 500 stations.',
          '9. Do not delete or modify the hidden system sheet _fleetfuel_meta.',
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

    const stations = workbook.addWorksheet(dataSheetName, {
      views: [{ state: 'frozen', ySplit: 1, rightToLeft: isArabic }],
    });

    stations.columns = STATION_COLUMNS.map((column) => ({
      header: column[language],
      key: column.canonicalField,
      width:
        column.canonicalField === 'stationName' ||
        column.canonicalField === 'stationType'
          ? 26
          : 20,
    }));

    const headerRow = stations.getRow(1);
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

    // Preserve IDs as text in Excel. Numeric operational values remain numeric.
    for (const field of ['stationId', 'projectCode'] as const) {
      const columnIndex =
        STATION_COLUMNS.findIndex((column) => column.canonicalField === field) + 1;
      stations.getColumn(columnIndex).numFmt = '@';

      for (let row = 2; row <= STATIONS_MAX_ROWS + 1; row += 1) {
        stations.getCell(row, columnIndex).numFmt = '@';
      }
    }

    const meta = workbook.addWorksheet('_fleetfuel_meta');
    meta.state = 'veryHidden';
    meta.addRows([
      ['metaKey', 'metaValue'],
      ['templateType', STATIONS_TEMPLATE_TYPE],
      ['schemaVersion', STATIONS_SCHEMA_VERSION],
      ['templateLanguage', language],
      ['dataSheet', dataSheetName],
      ['maxRows', STATIONS_MAX_ROWS],
      ['executionMode', 'ALL_OR_NOTHING'],
      ['defaultStatus', 'ACTIVE'],
      [],
      [],
      ['columnHeader', 'canonicalField', 'required', 'type', 'rules'],
      ...STATION_COLUMNS.map((column) => [
        column[language],
        column.canonicalField,
        column.required ? 'true' : 'false',
        column.type,
        JSON.stringify({
          ...('minInclusive' in column
            ? { minInclusive: column.minInclusive }
            : {}),
        }),
      ]),
    ]);

    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = `FleetFuelPRO_Stations_Import_Template_v${STATIONS_SCHEMA_VERSION}_${language}.xlsx`;

    return {
      buffer: Buffer.from(buffer),
      fileName,
      language,
      templateType: STATIONS_TEMPLATE_TYPE,
      schemaVersion: STATIONS_SCHEMA_VERSION,
    };
  }

}

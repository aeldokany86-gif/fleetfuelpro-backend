import { TelemetryDataSource } from '@prisma/client';
import { XirgoSensorDefinition } from './xirgo-sensor.mapper';

export const XIRGO_CORE_SENSOR_DEFINITIONS: XirgoSensorDefinition[] = [
  // Device / GNSS sensors
  { vendorSensorId: '8192', parameterCode: 'GNSS_SPEED', displayName: 'GNSS Speed', unit: 'km/h', multiplier: 1, offset: 0, dataSource: TelemetryDataSource.GNSS, isActive: true },
  { vendorSensorId: '12288', parameterCode: 'EXTERNAL_SUPPLY_VOLTAGE', displayName: 'External Supply Voltage', unit: 'mV', multiplier: 1, offset: 0, dataSource: TelemetryDataSource.DEVICE, isActive: true },
  { vendorSensorId: '12292', parameterCode: 'DEVICE_BATTERY_VOLTAGE', displayName: 'Device Battery Voltage', unit: 'mV', multiplier: 1, offset: 0, dataSource: TelemetryDataSource.DEVICE, isActive: true },

  { vendorSensorId: '141', parameterCode: 'ENGINE_WORKING', displayName: 'Engine Working', unit: null, multiplier: 1, offset: 0, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },
  { vendorSensorId: '159', parameterCode: 'CAN_ACTIVITY_PRESENT', displayName: 'CAN Activity Present', unit: null, multiplier: 1, offset: 0, dataSource: TelemetryDataSource.DEVICE, isActive: true },
  { vendorSensorId: '171', parameterCode: 'CAN_1_ACTIVITY_PRESENT', displayName: 'CAN 1 Activity Present', unit: null, multiplier: 1, offset: 0, dataSource: TelemetryDataSource.DEVICE, isActive: true },
  { vendorSensorId: '172', parameterCode: 'CAN_2_ACTIVITY_PRESENT', displayName: 'CAN 2 Activity Present', unit: null, multiplier: 1, offset: 0, dataSource: TelemetryDataSource.DEVICE, isActive: true },

  // Xirgo describes this as either litres or percentage depending on CAN/FMS configuration.
  { vendorSensorId: '8199', parameterCode: 'FUEL_LEVEL_GENERIC', displayName: 'Fuel Level 1', unit: '%/L', multiplier: 1, offset: 0, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },

  { vendorSensorId: '8200', parameterCode: 'ENGINE_TEMPERATURE', displayName: 'Engine Temperature', unit: '°C', multiplier: 1, offset: -40, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },
  { vendorSensorId: '8202', parameterCode: 'ENGINE_LOAD', displayName: 'Engine Load', unit: '%', multiplier: 1, offset: 0, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },
  { vendorSensorId: '8198', parameterCode: 'ACCELERATOR_PEDAL_POSITION', displayName: 'Accelerator Pedal Position', unit: '%', multiplier: 0.4, offset: 0, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },
  { vendorSensorId: '8201', parameterCode: 'FUEL_LEVEL_2_GENERIC', displayName: 'Fuel Level 2', unit: '%/L', multiplier: 1, offset: 0, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },
  { vendorSensorId: '8234', parameterCode: 'FUEL_LEVEL_TYPE', displayName: 'Fuel Level Type', unit: null, multiplier: 1, offset: 0, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },
  { vendorSensorId: '8275', parameterCode: 'FUEL_LEVEL_PERCENT', displayName: 'Fuel Level Percent', unit: '%', multiplier: 0.4, offset: 0, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },
  { vendorSensorId: '12300', parameterCode: 'ENGINE_RPM', displayName: 'Engine Speed', unit: 'rpm', multiplier: 0.125, offset: 0, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },
  { vendorSensorId: '12318', parameterCode: 'FUEL_LEVEL_L', displayName: 'Fuel Level Volume', unit: 'L', multiplier: 1, offset: 0, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },
  { vendorSensorId: '12321', parameterCode: 'FUEL_RATE', displayName: 'Fuel Rate', unit: 'L/h', multiplier: 0.05, offset: 0, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },
  { vendorSensorId: '12317', parameterCode: 'WHEEL_SPEED', displayName: 'Wheel Speed', unit: 'km/h', multiplier: 1, offset: 0, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },
  { vendorSensorId: '12330', parameterCode: 'AMBIENT_TEMPERATURE', displayName: 'Ambient Air Temperature', unit: '°C', multiplier: 0.03125, offset: -273, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },
  { vendorSensorId: '12346', parameterCode: 'REMAINING_RANGE', displayName: 'Remaining Distance With Current Fuel Level', unit: 'km', multiplier: 1, offset: 0, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },

  { vendorSensorId: '16385', parameterCode: 'TOTAL_FUEL_USED', displayName: 'Total Fuel Used', unit: 'L', multiplier: 0.5, offset: 0, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },
  { vendorSensorId: '16386', parameterCode: 'TOTAL_ENGINE_HOURS', displayName: 'Total Engine Hours', unit: 'h', multiplier: 0.05, offset: 0, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },
  { vendorSensorId: '16387', parameterCode: 'TOTAL_DISTANCE', displayName: 'Total Distance', unit: 'km', multiplier: 0.005, offset: 0, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },

  { vendorSensorId: '16470', parameterCode: 'RECEIVED_CAN_MESSAGES', displayName: 'Received CAN Messages', unit: null, multiplier: 1, offset: 0, dataSource: TelemetryDataSource.DEVICE, isActive: true },
  { vendorSensorId: '16471', parameterCode: 'MISSED_CAN_MESSAGES', displayName: 'Missed CAN Messages', unit: null, multiplier: 1, offset: 0, dataSource: TelemetryDataSource.DEVICE, isActive: true },
  { vendorSensorId: '16472', parameterCode: 'CAN_1_BIT_RATE', displayName: 'CAN 1 Bit Rate', unit: 'bps', multiplier: 1, offset: 0, dataSource: TelemetryDataSource.DEVICE, isActive: true },
  { vendorSensorId: '16473', parameterCode: 'CAN_2_BIT_RATE', displayName: 'CAN 2 Bit Rate', unit: 'bps', multiplier: 1, offset: 0, dataSource: TelemetryDataSource.DEVICE, isActive: true },

  { vendorSensorId: '16474', parameterCode: 'TOTAL_FUEL_USED_HIGH_RES', displayName: 'Total Fuel Used High Resolution', unit: 'L', multiplier: 0.001, offset: 0, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },
  { vendorSensorId: '16475', parameterCode: 'TACHO_ODOMETER', displayName: 'Tachograph Odometer', unit: 'km', multiplier: 0.005, offset: 0, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },
  { vendorSensorId: '16482', parameterCode: 'TOTAL_DISTANCE_HIGH_RES', displayName: 'Total Distance High Resolution', unit: 'km', multiplier: 0.005, offset: 0, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },
  { vendorSensorId: '16488', parameterCode: 'IDLE_TOTAL_FUEL_USED', displayName: 'Idle Total Fuel Used', unit: 'L', multiplier: 0.5, offset: 0, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },
  { vendorSensorId: '16489', parameterCode: 'IDLE_TOTAL_HOURS', displayName: 'Idle Total Hours', unit: 'h', multiplier: 0.05, offset: 0, dataSource: TelemetryDataSource.ECU_CAN, isActive: true },

  // Important: this is GNSS-derived odometer, not ECU/CAN total distance.
  { vendorSensorId: '45058', parameterCode: 'GNSS_DISTANCE', displayName: 'GNSS Odometer', unit: 'm', multiplier: 0.0001, offset: 0, dataSource: TelemetryDataSource.GNSS, isActive: true },
];

export function getXirgoCoreSensorDefinition(
  sensorId: number | string,
): XirgoSensorDefinition | undefined {
  return XIRGO_CORE_SENSOR_DEFINITIONS.find(
    (definition) => definition.vendorSensorId === String(sensorId),
  );
}

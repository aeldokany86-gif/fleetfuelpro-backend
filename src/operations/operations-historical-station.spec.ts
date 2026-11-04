import { OperationsService } from './operations.service';

describe('Historical station operation protections', () => {
  const service = Object.create(OperationsService.prototype) as OperationsService;

  function mockDatabase(readings: Array<{ id: string; value: number; at: string }>, resets: any[] = [], opening = 100) {
    return {
      station: {
        findFirst: jest.fn(async () => ({ id: 'station-1', openingCounter: opening })),
      },
      operationStationCounterReading: {
        findMany: jest.fn(async () => readings.map((item) => ({
          id: item.id,
          counterValue: item.value,
          operation: { occurredAt: new Date(item.at), createdAt: new Date(item.at) },
        }))),
      },
      stationCounterReset: { findMany: jest.fn(async () => resets) },
    };
  }

  const stationEntities = {
    destinationStation: { id: 'station-1', companyId: 'tenant-1', structureType: 'STANDALONE' },
  };

  const candidate = (value: number) => ({
    stationCounter: value,
    destinationStationId: 'station-1',
    historicalStationId: 'station-1',
  });

  const validate = (db: any, dto: any, occurredAt = '2026-10-02T12:00:00Z', entities: any = stationEntities) =>
    (service as any).validateHistoricalStationCounterPlacement(
      db, 'EXTERNAL_SUPPLY', dto, entities, new Date(occurredAt),
    );

  const readings = [
    { id: 'a', value: 120, at: '2026-10-01T12:00:00Z' },
    { id: 'b', value: 180, at: '2026-10-03T12:00:00Z' },
  ];

  it('accepts an inserted meter reading between historical neighbors', async () => {
    await expect(validate(mockDatabase(readings), candidate(150))).resolves.toBeUndefined();
  });

  it('rejects a reading below its historical predecessor', async () => {
    await expect(validate(mockDatabase(readings), candidate(119))).rejects.toThrow(
      'between the previous and following readings',
    );
  });

  it('rejects a reading higher than the following historical operation', async () => {
    await expect(validate(mockDatabase(readings), candidate(181))).rejects.toThrow(
      'between the previous and following readings',
    );
  });

  it('uses the new meter cycle after a reset', async () => {
    const db = mockDatabase([
      { id: 'before-reset', value: 970, at: '2026-10-01T12:00:00Z' },
      { id: 'after-reset', value: 30, at: '2026-10-04T12:00:00Z' },
    ], [{
      id: 'reset-1', oldCounter: 980, newCounter: 10,
      effectiveAt: new Date('2026-10-02T00:00:00Z'),
      createdAt: new Date('2026-10-02T00:00:00Z'),
    }], 900);
    await expect(validate(db, candidate(20), '2026-10-03T12:00:00Z')).resolves.toBeUndefined();
    await expect(validate(db, candidate(970), '2026-10-03T12:00:00Z')).rejects.toThrow(
      'between the previous and following readings',
    );
  });

  it('requires a station opening counter before backdating', async () => {
    const db = mockDatabase(readings);
    db.station.findFirst.mockResolvedValueOnce({ id: 'station-1', openingCounter: null } as any);
    await expect(validate(db, candidate(150))).rejects.toThrow('Opening Counter');
  });

  it('rejects missing or forged station identity', () => {
    const dto = {
      type: 'EXTERNAL_SUPPLY',
      historicalStationId: 'other-station',
      destinationStationId: 'station-1',
      occurredAt: '2026-10-02T12:00:00Z',
    };
    expect(() => (service as any).validateHistoricalMissingOperationCreate({
      role: 'Supervisor',
    }, 'EXTERNAL_SUPPLY', dto)).toThrow('must match the source or destination');
  });

  it('refuses an Operator on the historical station path', () => {
    expect(() => (service as any).validateHistoricalMissingOperationCreate({
      role: 'Operator',
    }, 'EXTERNAL_SUPPLY', {
      type: 'EXTERNAL_SUPPLY',
      historicalStationId: 'station-1',
      destinationStationId: 'station-1',
      occurredAt: '2026-10-02T12:00:00Z',
    })).toThrow('cannot add or request');
  });
});

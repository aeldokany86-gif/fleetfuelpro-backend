DELETE FROM "StationStockMovement" WHERE "stationId" IN (SELECT id FROM "Station" WHERE "stationId" = 'st-001');
DELETE FROM "StationAssignmentHistory" WHERE "stationId" IN (SELECT id FROM "Station" WHERE "stationId" = 'st-001');
DELETE FROM "StationCounterReset" WHERE "stationId" IN (SELECT id FROM "Station" WHERE "stationId" = 'st-001');
DELETE FROM "StationPriceHistory" WHERE "stationId" IN (SELECT id FROM "Station" WHERE "stationId" = 'st-001');
DELETE FROM "Station" WHERE "stationId" = 'st-001';

import { Injectable } from '@nestjs/common';
import { Observable, Subject, filter } from 'rxjs';

export type OperationRealtimeEventType =
  | 'operation.created'
  | 'operation.updated';

export type OperationRealtimeEvent = {
  type: OperationRealtimeEventType;
  companyId: string;
  actorUserId: string;
  operationId: string;
  operationNo: string;
  operationType: string;
  status: string;
  projectIds: string[];
  occurredAt: string;
};

@Injectable()
export class OperationsRealtimeService {
  private readonly events$ = new Subject<OperationRealtimeEvent>();

  publish(event: OperationRealtimeEvent) {
    this.events$.next(event);
  }

  eventsForCompany(companyId: string): Observable<OperationRealtimeEvent> {
    return this.events$.pipe(
      filter((event) => event.companyId === companyId),
    );
  }
}

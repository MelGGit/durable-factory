export interface DeletionOperation {
  id: string;
  conversationIds: string[];
  runId?: string;
  state:
    | 'pending'
    | 'stopping'
    | 'waiting'
    | 'deleting'
    | 'blocked'
    | 'completed';
  message: string;
}

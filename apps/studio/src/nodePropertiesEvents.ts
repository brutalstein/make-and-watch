export const EDIT_NODE_PROPERTIES_EVENT = 'makewatch:edit-node-properties';

export interface EditNodePropertiesDetail {
  nodeId: string;
}

export function editNodeProperties(nodeId: string) {
  window.dispatchEvent(new CustomEvent<EditNodePropertiesDetail>(EDIT_NODE_PROPERTIES_EVENT, {
    detail: { nodeId },
  }));
}

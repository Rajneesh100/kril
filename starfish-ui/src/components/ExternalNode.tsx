import React, { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';

interface ExternalNodeData {
  label: string;
  isDatabase: boolean;
}

const ExternalNode: React.FC<NodeProps<ExternalNodeData>> = ({ data }) => {
  return (
    <div className={`ext-node ${data.isDatabase ? 'database' : ''}`}>
      <Handle type="target" position={Position.Top} style={{ background: 'var(--border-glass-active)', border: 'none', width: 6, height: 6 }} />
      <span>{data.isDatabase ? '🛢' : '🔗'}</span>
      <div className="fn-node-label" style={{ fontSize: 10 }}>{data.label}</div>
    </div>
  );
};

export default memo(ExternalNode);

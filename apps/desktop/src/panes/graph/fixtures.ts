import type { Canvas, VaultGraph } from './vault-graph';

/** A small made-up vault for tests: one question, two claims, one piece of evidence. */

export const VAULT = '/vault';

export const OVERVIEW: Canvas = {
  name: 'Overview',
  path: `${VAULT}/Canvases/Overview.md`,
  pages: [
    { id: 'page:notes', name: 'Notes' },
    { id: 'page:main', name: 'Main' },
    { id: 'page:detail', name: 'Detail' },
    { id: 'page:empty', name: 'Empty' },
  ],
  nodes: [
    {
      id: 'shape:q',
      pageId: 'page:main',
      x: 400,
      y: 0,
      w: 400,
      h: 112,
      title: 'QUE - Does it scale',
      typeId: 'node_q',
      path: `${VAULT}/QUE - Does it scale.md`,
    },
    {
      id: 'shape:c',
      pageId: 'page:main',
      x: 0,
      y: 300,
      w: 200,
      h: 100,
      title: 'CLM - It scales',
      typeId: 'node_c',
      path: `${VAULT}/claims/CLM - It scales.md`,
    },
    {
      id: 'shape:lost',
      pageId: 'page:detail',
      x: 0,
      y: 0,
      w: 200,
      h: 100,
      title: 'CLM - Deleted since',
      typeId: 'node_c',
      path: null,
    },
  ],
  relations: [
    {
      id: 'shape:arrow',
      pageId: 'page:main',
      typeId: 'rel_s',
      label: 'backs up',
      source: 'shape:c',
      destination: 'shape:q',
    },
  ],
  texts: [
    {
      id: 'shape:t',
      pageId: 'page:notes',
      x: -100,
      y: -200,
      w: 260,
      size: 'xl',
      scale: 1.5,
      text: 'Untested\nclaims',
    },
  ],
  unboundRelations: 1,
  otherShapes: 2,
};

export const GRAPH: VaultGraph = {
  directory: VAULT,
  message: null,
  warnings: [],
  truncated: false,
  incomplete: false,
  nodeTypes: [
    { id: 'node_q', name: 'Question', format: 'QUE - {content}', color: '#F2C123' },
    { id: 'node_c', name: 'Claim', format: 'CLM - {content}', color: '#2E9E82' },
    { id: 'node_e', name: 'Evidence', format: 'EVD - {content}', color: '#8B1A30' },
    { id: 'node_unused', name: 'Source', format: '@{content}', color: null },
  ],
  relationTypes: [
    { id: 'rel_s', label: 'supports', complement: 'is supported by', color: 'green' },
    { id: 'relation_o', label: 'opposes', complement: 'is opposed by', color: 'red' },
    { id: 'rel_p', label: 'produces', complement: 'is produced by', color: 'black' },
  ],
  nodes: [
    {
      id: 'id-q',
      typeId: 'node_q',
      title: 'QUE - Does it scale',
      path: `${VAULT}/QUE - Does it scale.md`,
    },
    {
      id: 'id-c1',
      typeId: 'node_c',
      title: 'CLM - It scales',
      path: `${VAULT}/claims/CLM - It scales.md`,
    },
    {
      id: 'id-c2',
      typeId: 'node_c',
      title: 'CLM - It does not',
      path: `${VAULT}/claims/CLM - It does not.md`,
    },
    {
      id: 'id-e',
      typeId: 'node_e',
      title: 'EVD - Benchmark run',
      path: `${VAULT}/EVD - Benchmark run.md`,
    },
    {
      id: `path:${VAULT}/CLM - Alone.md`,
      typeId: 'node_c',
      title: 'CLM - Alone',
      path: `${VAULT}/CLM - Alone.md`,
    },
  ],
  relations: [
    {
      id: 'r1',
      typeId: 'rel_s',
      source: 'id-c1',
      destination: 'id-q',
      ambiguous: false,
      tentative: null,
    },
    {
      id: 'r2',
      typeId: 'relation_o',
      source: 'id-c2',
      destination: 'id-q',
      ambiguous: false,
      tentative: false,
    },
    {
      id: 'r3',
      typeId: 'rel_s',
      source: 'id-e',
      destination: 'id-c1',
      ambiguous: true,
      tentative: null,
    },
  ],
  skippedRelations: 2,
  repeatedIds: 0,
  canvases: [OVERVIEW],
};

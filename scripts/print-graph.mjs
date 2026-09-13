/** Prints the Warrant LangGraph as Mermaid (paste into README or mermaid.live). */
import 'dotenv/config';
const { graph } = await import('../src/graph.js');
console.log(graph.getGraph().drawMermaid());

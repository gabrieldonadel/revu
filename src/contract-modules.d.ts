// Module shape for `.contract` files compiled by the Contract Vite plugin
// (@exact/contract/vite-plugin).
declare module '*.contract' {
  const component: import('@exact/contract').CompiledComponent;
  export default component;
  export const __contracts: unknown[];
}

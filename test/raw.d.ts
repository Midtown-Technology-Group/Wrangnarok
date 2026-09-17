declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}
declare module "*.txt?raw" {
  const text: string;
  export default text;
}
declare module "*.toml?raw" {
  const text: string;
  export default text;
}
declare module "*.yml?raw" {
  const text: string;
  export default text;
}

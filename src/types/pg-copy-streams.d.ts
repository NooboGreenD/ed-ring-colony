declare module 'pg-copy-streams' {
  export function from(sql: string): NodeJS.WritableStream;
  export function to(sql: string): NodeJS.ReadableStream;
}

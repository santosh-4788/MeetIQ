// swagger-ui-dist (MIT) ships no TypeScript types. Only what the API Documentation page uses.
declare module 'swagger-ui-dist/swagger-ui-es-bundle.js' {
  type SwaggerUIOptions = {
    url?: string
    domNode: HTMLElement
    deepLinking?: boolean
    docExpansion?: 'list' | 'full' | 'none'
    defaultModelsExpandDepth?: number
    persistAuthorization?: boolean
    tryItOutEnabled?: boolean
    displayRequestDuration?: boolean
    filter?: boolean
  }
  const SwaggerUIBundle: (options: SwaggerUIOptions) => unknown
  export default SwaggerUIBundle
}
declare module 'swagger-ui-dist/swagger-ui.css'

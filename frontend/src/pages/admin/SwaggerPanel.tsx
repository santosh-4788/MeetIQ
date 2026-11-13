import { useEffect, useRef } from 'react'
import SwaggerUIBundle from 'swagger-ui-dist/swagger-ui-es-bundle.js'
import 'swagger-ui-dist/swagger-ui.css'
import { Card } from '../../components/ui/Card'

/** Interactive Swagger UI (swagger-ui-dist, MIT, bundled - no CDN) over the server's generated OpenAPI document. Separate chunk. */
export default function SwaggerPanel({ url }: { url: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return
    SwaggerUIBundle({ url, domNode: ref.current, deepLinking: false, docExpansion: 'list', defaultModelsExpandDepth: 0, persistAuthorization: false, displayRequestDuration: true, filter: true })
  }, [url])
  return (
    <Card className="overflow-hidden p-2 sm:p-4">
      <div ref={ref} className="oic-swagger" data-testid="swagger-ui" />
    </Card>
  )
}

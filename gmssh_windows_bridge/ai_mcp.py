"""Official MCP SDK stdio adapter over the exact same operations as the CLI."""
import asyncio
import json

from .ai import Operations, TOOLS


def create_server(registry):
    from mcp.server import Server
    from mcp.types import CallToolResult, ImageContent, TextContent, Tool, ToolAnnotations

    server = Server('gmssh')
    operations = Operations(registry)

    @server.list_tools()
    async def list_tools():
        return [Tool(name=item['name'], description=item['description'], inputSchema=item['inputSchema'],
                     outputSchema=item['outputSchema'], annotations=ToolAnnotations(
                         readOnlyHint=not item['mutates'], destructiveHint=item['mutates'],
                         idempotentHint=not item['mutates'], openWorldHint=item['name'] not in {'devices_list', 'tasks_list'})) for item in TOOLS]

    @server.call_tool()
    async def call_tool(name, arguments):
        value = await asyncio.to_thread(operations.call, name, arguments or {})
        image = None
        if name == 'desktop_screenshot' and value.get('ok'):
            result = value['result']
            image = ImageContent(type='image', mimeType=result['mimeType'], data=result.pop('data'))
            result['imageAttached'] = True
        content = [TextContent(type='text', text=json.dumps(value, ensure_ascii=False))]
        if image:
            content.append(image)
        return CallToolResult(content=content, structuredContent=value, isError=not value['ok'])

    return server


async def serve(registry):
    from mcp.server.stdio import stdio_server
    server = create_server(registry)
    async with stdio_server() as (reader, writer):
        await server.run(reader, writer, server.create_initialization_options())


def main(registry):
    asyncio.run(serve(registry))
    return 0

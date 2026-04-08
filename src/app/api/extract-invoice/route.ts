import { NextRequest, NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";

const EXTRACTION_PROMPT = `Eres un experto en extracción de datos de facturas eléctricas españolas. Analiza esta imagen/documento de factura de electricidad y extrae la siguiente información.

Responde ÚNICAMENTE en formato JSON válido con estos campos (usa null si no encuentras el dato):
{
  "titular": "nombre completo del titular de la factura",
  "cups": "código CUPS (empezará por ES y 20-22 caracteres)",
  "direccion": "dirección de suministro completa",
  "comercializadora": "nombre de la comercializadora actual",
  "tarifa": "tipo de tarifa (ej: 2.0TD, 3.0TD, 6.1TD, etc.)",
  "potencia_p1": "potencia contratada en periodo P1 con unidad (ej: 4.6 kW)",
  "potencia_p2": "potencia contratada en periodo P2 con unidad (ej: 4.6 kW)",
  "consumo_mensual": "consumo total en kWh (solo el número)",
  "importe_total": "importe total de la factura con símbolo € (ej: 67.43 €)",
  "fecha_factura": "fecha de la factura en formato DD/MM/YYYY",
  "periodo_facturacion": "periodo de facturación (ej: 30 días, del 01/03 al 31/03)"
}

Reglas:
- Extrae SOLO la información visible en la factura
- Si un dato no se puede leer claramente, pon null
- El CUPS siempre empieza por ES
- Mantén los formatos originales cuando sea posible
- Responde SOLO con el JSON, sin texto adicional ni markdown`;

function getMimeType(fileName: string): string {
  const ext = fileName?.split(".").pop()?.toLowerCase() || "";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "pdf") return "application/pdf";
  return "image/jpeg";
}

function isDocumentType(mimeType: string): boolean {
  return mimeType === "application/pdf" || mimeType === "application/docx" || mimeType === "application/txt";
}

function buildContent(prompt: string, fileBase64: string, mimeType: string) {
  const dataUri = `data:${mimeType};base64,${fileBase64}`;

  if (isDocumentType(mimeType)) {
    // Use file_url for document types (PDF, DOCX, etc.)
    return [
      { type: "text" as const, text: prompt },
      { type: "file_url" as const, file_url: { url: dataUri } },
    ];
  }

  // Use image_url for image types (JPG, PNG, WebP, etc.)
  return [
    { type: "text" as const, text: prompt },
    { type: "image_url" as const, image_url: { url: dataUri } },
  ];
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { fileBase64, fileName } = body;

    if (!fileBase64) {
      return NextResponse.json(
        { error: "No se proporcionó archivo de factura" },
        { status: 400 }
      );
    }

    const mimeType = getMimeType(fileName || "");
    console.log(`[VLM] Processing invoice: ${fileName || "unknown"}, type: ${mimeType}, size: ${Math.round((fileBase64.length * 3) / 4 / 1024)}KB`);

    const zai = await ZAI.create();

    const content = buildContent(EXTRACTION_PROMPT, fileBase64, mimeType);

    // Set a 60-second timeout for the VLM call
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    let response;
    try {
      response = await zai.chat.completions.createVision({
        messages: [
          {
            role: "user",
            content,
          },
        ],
        thinking: { type: "disabled" },
      } as Parameters<typeof zai.chat.completions.createVision>[0]);
    } finally {
      clearTimeout(timeout);
    }

    const rawContent = response.choices?.[0]?.message?.content;

    if (!rawContent) {
      console.error("[VLM] Empty response from vision model");
      return NextResponse.json(
        { error: "No se pudo extraer información de la factura. El modelo no devolvió datos." },
        { status: 500 }
      );
    }

    console.log("[VLM] Raw response length:", rawContent.length);
    console.log("[VLM] Raw response preview:", rawContent.substring(0, 200));

    // Parse the JSON from the response (handle potential markdown wrapping)
    let extractedData;
    try {
      // Try direct parse first
      extractedData = JSON.parse(rawContent);
    } catch {
      // Try extracting JSON from markdown code blocks
      const jsonMatch = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        extractedData = JSON.parse(jsonMatch[1].trim());
      } else {
        // Try finding JSON object in the response
        const objMatch = rawContent.match(/\{[\s\S]*\}/);
        if (objMatch) {
          extractedData = JSON.parse(objMatch[0]);
        } else {
          console.error("[VLM] Could not parse JSON from response:", rawContent);
          throw new Error("No se pudo interpretar la respuesta del modelo como JSON");
        }
      }
    }

    console.log("[VLM] Invoice extracted successfully:", {
      titular: extractedData.titular,
      cups: extractedData.cups,
      comercializadora: extractedData.comercializadora,
      tarifa: extractedData.tarifa,
      importe: extractedData.importe_total,
    });

    return NextResponse.json({
      success: true,
      data: extractedData,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("[API] Error in extract-invoice:", errMsg);

    if (errMsg.includes("abort") || errMsg.includes("timeout") || errMsg.includes("Timeout")) {
      return NextResponse.json(
        { error: "La extracción tardó demasiado. Inténtalo con una imagen más clara o más pequeña." },
        { status: 504 }
      );
    }

    return NextResponse.json(
      { error: "Error al procesar la factura. Inténtalo de nuevo con un archivo diferente.", details: errMsg },
      { status: 500 }
    );
  }
}

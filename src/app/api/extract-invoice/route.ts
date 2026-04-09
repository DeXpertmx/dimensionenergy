import { NextRequest, NextResponse } from "next/server";

import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

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

    // Determine MIME type from file name
    const ext = fileName?.split(".").pop()?.toLowerCase() || "";
    let mimeType = "image/jpeg";
    if (ext === "png") mimeType = "image/png";
    if (ext === "pdf") mimeType = "application/pdf";
    if (ext === "webp") mimeType = "image/webp";

    console.log("[Gemini] Processing invoice extraction:", {
      fileName,
      mimeType,
      fileSize: fileBase64.length,
    });

    const content = await callGoogleGemini(fileBase64, mimeType);

    if (!content) {
      return NextResponse.json(
        { error: "No se pudo extraer información de la factura" },
        { status: 500 }
      );
    }

    // Parse the JSON from the response (handle potential markdown wrapping)
    let extractedData;
    try {
      extractedData = JSON.parse(content);
    } catch {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        extractedData = JSON.parse(jsonMatch[1].trim());
      } else {
        const objMatch = content.match(/\{[\s\S]*\}/);
        if (objMatch) {
          extractedData = JSON.parse(objMatch[0]);
        } else {
          throw new Error("Could not parse extraction result");
        }
      }
    }

    console.log("[Gemini] Invoice extracted successfully:", {
      titular: extractedData.titular,
      cups: extractedData.cups,
      comercializadora: extractedData.comercializadora,
    });

    return NextResponse.json({
      success: true,
      data: extractedData,
    });
  } catch (error) {
    console.error("[API] Error in extract-invoice:", error);
    return NextResponse.json(
      { error: "Error al procesar la factura", details: String(error) },
      { status: 500 }
    );
  }
}
}

// Google Gemini API call
async function callGoogleGemini(fileBase64: string, mimeType: string): Promise<string> {
  const apiKey = process.env.GOOGLE_AI_API_KEY;

  if (!apiKey) {
    throw new Error("GOOGLE_AI_API_KEY no está configurada");
  }

  console.log("[Gemini] Initializing with API key present:", !!apiKey);

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    generationConfig: {
      temperature: 0,
      topP: 1,
      maxOutputTokens: 1500,
      responseMimeType: "application/json",
    },
  });

  // Convert base64 to Uint8Array
  const imageData = Uint8Array.from(atob(fileBase64), c => c.charCodeAt(0));

  const result = await model.generateContent([
    EXTRACTION_PROMPT,
    {
      inlineData: {
        data: imageData,
        mimeType: mimeType,
      },
    },
  ]);

  const response = await result.response;
  const text = response.text();

  console.log("[Gemini] Response received:", {
    textLength: text.length,
    textPreview: text.substring(0, 200),
  });

  return text;
}

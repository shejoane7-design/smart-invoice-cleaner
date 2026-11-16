import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

// 初始化 Supabase 與 Google GenAI
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.AI_API_KEY });

// 輔助函式：將本地圖片轉為 Gemini 要求的格式
function fileToGenerativePart(filePath, mimeType) {
    return {
        inlineData: {
            data: Buffer.from(fs.readFileSync(filePath)).toString("base64"),
            mimeType
        },
    };
}

// 透過 Google 官方 SDK 的多模態能力直接讀取圖片並清洗資料
async function recognizeAndCleanInvoiceImage(imagePath) {
    console.log("📸 正在讀取發票圖片並透過 Gemini 3.8 Flash 進行視覺辨識與標準化...");

    // 準備圖片內容
    const imagePart = fileToGenerativePart(imagePath, "image/png"); // 如果是 png 圖片請改為 "image/png"

    const prompt = `
    你是一個專業的發票光學辨識 (OCR) 與資料標準化 AI 助手。請直接觀察這張發票圖片，萃取並標準化以下欄位：
    1. 將日期轉換為標準格式 (YYYY-MM-DD)，民國轉西元（例如 115年 = 2026年）。
    2. 將賣方名稱清洗簡化為標準名稱（例如：統一超商、全家便利商店等）。
    3. 解析所有購買品項的名稱、數量、單價、小計。
    4. 依據消費性質將每個品項分類到對應的 category_id（例如：餐飲美食請填 "CAT_FOOD_DRINK"、子分類填 "SUBCAT_BEVERAGE"）。

    請嚴格回傳標準的 JSON 格式，不要包含任何 markdown 標籤（如 \`\`\`json 等）或額外文字，格式如下：
    {
      "invoice_number": "AB12345678",
      "invoice_date": "2026-11-09",
      "invoice_time": "14:30:00",
      "seller_name": "全家便利商店",
      "seller_ubn": "23060248",
      "total_amount": 85,
      "carrier_type": "PAPER_INVOICE",
      "status": "PAID",
      "items": [
        {
          "original_name": "發票上的原始商品名稱",
          "standard_name": "標準化品項名稱",
          "category_id": "CAT_FOOD_DRINK",
          "subcategory_id": "SUBCAT_BEVERAGE",
          "quantity": 1,
          "unit_price": 35,
          "amount": 35
        }
      ]
    }
    `;

    // 呼叫 gemini-3.8-flash 同時傳入圖片與提示詞
    const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: [prompt, imagePart],
        config: {
            temperature: 0.1
        }
    });

    let cleanDataText = response.text.trim();
    
    // 自動拔除可能帶有的 markdown 標籤
    cleanDataText = cleanDataText.replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/\s*```$/, "");

    return JSON.parse(cleanDataText);
}

// 將清洗後的資料寫入 Supabase 資料庫
async function saveToSupabase(cleanedData) {
    console.log("💾 正在將辨識出的標準化發票寫入 Supabase...");

    const { data: invoiceResult, error: invoiceError } = await supabase
        .from('invoices')
        .insert([{
            invoice_number: cleanedData.invoice_number,
            invoice_date: cleanedData.invoice_date,
            invoice_time: cleanedData.invoice_time,
            seller_name: cleanedData.seller_name,
            seller_ubn: cleanedData.seller_ubn,
            total_amount: cleanedData.total_amount,
            carrier_type: cleanedData.carrier_type,
            status: cleanedData.status
        }])
        .select('id')
        .single();

    if (invoiceError) {
        console.error("❌ 主表寫入失敗:", invoiceError.message);
        return;
    }

    const invoiceId = invoiceResult.id;
    console.log(`✅ 發票主表寫入成功！ID: ${invoiceId}`);

    const itemsToInsert = cleanedData.items.map(item => ({
        invoice_id: invoiceId,
        original_name: item.original_name,
        standard_name: item.standard_name,
        category_id: item.category_id,
        subcategory_id: item.subcategory_id,
        quantity: item.quantity,
        unit_price: item.unit_price,
        amount: item.amount
    }));

    const { error: itemsError } = await supabase
        .from('invoice_items')
        .insert(itemsToInsert);

    if (itemsError) {
        console.error("❌ 明細表寫入失敗:", itemsError.message);
    } else {
        console.log(`✅ 成功寫入 ${itemsToInsert.length} 筆辨識出的消費明細！`);
    }
}

// 執行主流程
async function main() {
    try {
        // 請將這裡的 'invoice.jpg' 換成你實際放的發票圖片檔名
        const imagePath = './invoice.jpg'; 

        const cleaned = await recognizeAndCleanInvoiceImage(imagePath);
        console.log("✨ AI 視覺辨識與清洗完成的結構化資料：", cleaned);
        await saveToSupabase(cleaned);
    } catch (error) {
        console.error("執行過程發生錯誤：", error);
    }
}

main();